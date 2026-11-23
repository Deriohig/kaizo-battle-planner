// TrainerAI_ShouldSwitch (trainer_ai.c:3894), singles: Luxray (battler 0, Electric) against Garchomp (battler 1, party 0,
// Dragon/Ground), with Gyarados (party 1, Water/Flying) and Roserade (party 2, Grass/Poison) on the bench. Each
// probability counts the 65536 values of RandNext().

import { describe, expect, it } from 'vitest';
import { shouldSwitch } from '../../../src/ai/choose/switch.js';
import {
  ABILITY_ARENA_TRAP, ABILITY_MAGNET_PULL, ABILITY_NATURAL_CURE, ABILITY_SHADOW_TAG, ABILITY_WATER_ABSORB,
  ABILITY_WONDER_GUARD, BATTLE_TYPE_TRAINER_DOUBLES, MON_CONDITION_SLEEP_1, MOVE_EFFECT_INGRAIN, TYPE_GHOST, TYPE_GROUND,
  TYPE_STEEL, VOLATILE_CONDITION_MEAN_LOOK,
} from '../../../src/ai/constants.js';
import type { Rational } from '../../../src/contracts/engine.js';
import { ONE, rat } from '../../../src/ai/odds.js';
import { AI_BATTLER as AI, type AiView, PLAYER_BATTLER as PLAYER } from '../../../src/ai/view.js';
import { FX, fixtureDeps, fixtureView } from './fixtures.js';
import { code, frozen, hitBy, immuneSwitchView, NO_SUPER_EFFECTIVE, noPick, switchOdds } from './miscHarness.js';

const M = FX.move;
/** 65536^n, the denominator of n draws. */
const U16 = (n: bigint) => 65536n ** n;
const STAY = { stay: ONE };
const IMMUNE_SWITCH = { 'switch 1': rat(3, 4), stay: rat(1, 4) };
/** Switch to `party` on `num` of `den`, else stay. */
const odds = (party: number, num: bigint, den: bigint) => ({ [`switch ${party}`]: rat(num, den), stay: rat(den - num, den) });

/** `base` (a view builder) changed by `patch`. */
const from = (base: () => AiView, patch: (v: AiView) => void) => () => {
  const v = base();
  patch(v);
  return v;
};
const immune = (patch: (v: AiView) => void) => from(immuneSwitchView, patch);

/** Garchomp asleep with Natural Cure and no super-effective move, after `move` hit it. */
const asleepAfter = (move: number, patch: (v: AiView) => void = () => {}) => from(() => hitBy(move), (v) => {
  Object.assign(v.mons[AI], { ability: ABILITY_NATURAL_CURE, status: MON_CONDITION_SLEEP_1, moves: [...NO_SUPER_EFFECTIVE] });
  patch(v);
});

describe('shouldSwitch', () => {
  it.each<[string, () => AiView, Record<string, Rational>]>([
    ['the immune bench switch (trainer_ai.c:3975, 3796)', immuneSwitchView, IMMUNE_SWITCH],
    // Trapped never switches (:3906–3911).
    ['trapped by Mean Look', immune((v) => void (v.mons[AI].statusVolatile = VOLATILE_CONDITION_MEAN_LOOK)), STAY],
    ['trapped by Ingrain', immune((v) => void (v.mons[AI].moveEffectsMask = MOVE_EFFECT_INGRAIN)), STAY],
    ['trapped by Shadow Tag', immune((v) => void (v.mons[PLAYER].ability = ABILITY_SHADOW_TAG)), STAY],
    ['trapped by Arena Trap', immune((v) => void (v.mons[PLAYER].ability = ABILITY_ARENA_TRAP)), STAY],
    ['trapped by Magnet Pull, as a Steel type', immune((v) => {
      v.mons[PLAYER].ability = ABILITY_MAGNET_PULL;
      v.mons[AI].types = [TYPE_STEEL, TYPE_GROUND];
    }), STAY],
    ['not trapped by Magnet Pull otherwise', immune((v) => void (v.mons[PLAYER].ability = ABILITY_MAGNET_PULL)), IMMUNE_SWITCH],
    ['no living bench (:3926–3940)', immune((v) => {
      v.parties[1][1]!.hp = 0;
      v.parties[1][2]!.hp = 0;
    }), STAY],
    // +2 Attack and +2 Speed sum to 4 (a u8) and keep it in, before the immune check (:3872–3884, 3969–3971).
    ['+4 stages stays', immune((v) => void (v.mons[AI].statBoosts = [6, 8, 6, 8, 6, 6, 6, 6])), STAY],
    ['+3 stages does not', immune((v) => void (v.mons[AI].statBoosts = [6, 8, 6, 7, 6, 6, 6, 6])), IMMUNE_SWITCH],
    // No super-effective move on Garchomp or Gyarados; Roserade has Earthquake: `% 3 < 2` (:3298–3346).
    ['against Wonder Guard', from(fixtureView, (v) => {
      v.mons[PLAYER].ability = ABILITY_WONDER_GUARD;
      v.mons[AI].moves = [...NO_SUPER_EFFECTIVE];
      v.parties[1][2]!.moves = [M.ENERGY_BALL, M.SLUDGE_BOMB, M.EARTHQUAKE, M.HIDDEN_POWER];
    }), odds(2, 43691n, 65536n)],
    // Luxray made Ghost: Tackle and Hyper Beam are ineffective (:3385–3415). In singles both defenders are the player
    // (:3378–3379), so Gyarados's Crunch draws `% 3 < 2` twice (:3459, 3477), then Waterfall `% 2 == 0` twice (:3518, 3536).
    ['with only ineffective moves', from(fixtureView, (v) => {
      v.mons[PLAYER].types = [TYPE_GHOST, TYPE_GHOST];
      v.mons[AI].moves = [M.TACKLE, M.HYPER_BEAM, 0, 0];
      v.parties[1][1]!.moves = [M.CRUNCH, M.WATERFALL, M.PROTECT, 0];
      v.parties[1][2]!.hp = 0;
    }), odds(1, U16(4n) - 21845n ** 2n * 32768n ** 2n, U16(4n))],
    // Water Gun into Gyarados's Water Absorb: `RandNext() & 1` (:3668–3669, 3706).
    ['to absorb a hit', from(() => hitBy(M.WATER_GUN), (v) => {
      v.mons[AI].moves = [...NO_SUPER_EFFECTIVE];
      v.parties[1][1]!.ability = ABILITY_WATER_ABSORB;
    }), odds(1, 1n, 2n)],
    // With Earthquake, `RandNext() % 3 != 0` (21846/65536) skips the absorb check first (:3651).
    ['to absorb a hit, with a super-effective move', from(() => hitBy(M.WATER_GUN), (v) => {
      v.parties[1][1]!.ability = ABILITY_WATER_ABSORB;
    }), odds(1, 21846n * 32768n, U16(2n))],
    // Three coins reach the post-KO logic, 1/2 + 1/4 + 1/8: moveHit NONE (:3828), its power 0 (:3835), the last (:3853).
    ['with Natural Cure while asleep', from(fixtureView, (v) => {
      v.mons[AI].ability = ABILITY_NATURAL_CURE;
      v.mons[AI].status = MON_CONDITION_SLEEP_1;
    }), { postKo: rat(7, 8), stay: rat(1, 8) }],
    // After a damaging hit no coin is drawn at :3828 or :3835, and the party checks run with rand 1 (:3842, 3848, 3796).
    ['with Natural Cure, to a bench Pokémon immune to the hit', asleepAfter(M.EARTHQUAKE, (v) => {
      v.parties[1][1]!.moves = [M.WATERFALL, M.EARTHQUAKE, M.ICE_FANG, M.PROTECT];
    }), { 'switch 1': ONE }],
    ['with Natural Cure, to a bench Pokémon resisting the hit (Seismic Toss)', asleepAfter(M.SEISMIC_TOSS, (v) => {
      v.parties[1][2]!.moves = [M.ENERGY_BALL, M.EARTHQUAKE, M.SHADOW_BALL, M.HIDDEN_POWER];
    }), { 'switch 2': ONE }],
    ['with Natural Cure and no super-effective bench move', asleepAfter(M.SEISMIC_TOSS), { postKo: rat(1, 2), stay: rat(1, 2) }],
    // Earthquake keeps Garchomp in on `% 10 != 0` (:3588, 3964), after the absorb check's `% 3 != 0` (:3651); otherwise
    // Roserade resists Spark and has Earthquake: `% 3 == 0` (:3981, 3796).
    ['with a super-effective move', from(() => hitBy(M.SPARK), (v) => {
      v.parties[1][2]!.moves = [M.ENERGY_BALL, M.EARTHQUAKE, M.SHADOW_BALL, M.HIDDEN_POWER];
    }), odds(2, 6554n * 21846n, U16(2n))],
  ])('%s', (_, build, expected) => {
    expect(switchOdds(build())).toEqual(expected);
  });

  it('Wonder Guard over a Weather Ball user in clear weather throws UNDEFINED (trainer_ai.c:3302, 3222)', () => {
    const v = fixtureView();
    v.mons[PLAYER].ability = ABILITY_WONDER_GUARD;
    v.mons[AI].moves = [M.WEATHER_BALL, M.DRAGON_CLAW, M.CRUNCH, M.FIRE_FANG];
    expect(() => shouldSwitch(frozen(v), fixtureDeps(), noPick)).toThrow(code('UNDEFINED'));
  });

  it('doubles are unsupported', () => {
    expect(() => shouldSwitch(fixtureView({ battleType: BATTLE_TYPE_TRAINER_DOUBLES }), fixtureDeps(), noPick))
      .toThrow(code('UNSUPPORTED'));
  });
});
