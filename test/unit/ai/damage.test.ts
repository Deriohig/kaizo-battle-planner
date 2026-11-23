// The trainer AI's damage estimate (TrainerAI_CalcDamage, TrainerAI_CalcAllDamage) over BattleSystem_CalcMoveDamage:
// Garchomp (battler 1: Atk 150, level 50, Dragon/Ground) into Luxray (battler 0: Def 99, Electric).

import { describe, expect, it } from 'vitest';
import {
  BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED, MOVE_GYRO_BALL, SYSCTL_IGNORE_TYPE_CHECKS, TYPE_DRAGON, TYPE_ELECTRIC,
  TYPE_FLYING, TYPE_GHOST, TYPE_ICE, TYPE_NORMAL, TYPE_ROCK, TYPE_STEEL,
} from '../../../src/ai/constants.js';
import { enumerate, type Pick } from '../../../src/ai/enumerate.js';
import { aiCalcAllDamage, aiCalcDamage, calcMoveDamage } from '../../../src/ai/lib/damage.js';
import { rat, residueWeights } from '../../../src/ai/odds.js';
import { AI_BATTLER as AI, type AiBattleMon, type AiDeps, type AiView, PLAYER_BATTLER as PLAYER } from '../../../src/ai/view.js';
import { FX, fixtureDeps, fixtureView } from './fixtures.js';
import { code, frozen, latents, noPick } from './miscHarness.js';

const M = FX.move;

/** The fixture's deps plus a Gyro Ball record. */
function deps(): AiDeps {
  const d = fixtureDeps();
  d.moves[MOVE_GYRO_BALL] = {
    id: MOVE_GYRO_BALL, effect: BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED, category: 'physical', power: 1, type: TYPE_STEEL,
    accuracy: 100, pp: 5, effectChance: 0, target: 0, priority: 0, flags: 0,
  };
  return d;
}

/** The fixture with Garchomp and Luxray patched. */
function view(ai: Partial<AiBattleMon> = {}, player: Partial<AiBattleMon> = {}, patch: Partial<AiView> = {}): AiView {
  const v = Object.assign(fixtureView(), patch);
  Object.assign(v.mons[AI], ai);
  Object.assign(v.mons[PLAYER], player);
  return frozen(v);
}

/** TrainerAI_CalcDamage for Garchomp into Luxray, with Garchomp's own item, IVs, ability and Embargo turns. */
function estimate(v: AiView, d: AiDeps, move: number, variance: number, pick: Pick = noPick): number {
  const mon = v.mons[AI];
  return aiCalcDamage(v, d, move, mon.heldItem, mon.ivs, AI, AI, PLAYER, mon.ability, mon.effects.embargoTurns, variance, pick);
}

/** Every value of a random estimate, as `{ value, probability }` in first-seen order. */
const leavesOf = (v: AiView, d: AiDeps, move: number) => enumerate((pick) => estimate(v, d, move, 100, pick), String);
const leaves = (values: number[], weights: bigint[]) => values.map((value, i) => ({ value, probability: rat(weights[i]!, 65536) }));

/** Psywave from level 50: 50 * (RandNext() % 11 + 5) / 10 = 5 * (i + 5) for residue i (trainer_ai.c:3015). */
const PSYWAVE = leaves(Array.from({ length: 11 }, (_, i) => 5 * (i + 5)), residueWeights(11));

describe('aiCalcDamage', () => {
  it('matches BattleSystem_CalcMoveDamage on a worked case, then applies the type chart', () => {
    const v = view({ attack: 120, types: [TYPE_NORMAL, TYPE_NORMAL] }, { defense: 100, types: [TYPE_ELECTRIC, TYPE_ROCK] });
    // Tackle: 120 * 35 * 22 / 100 / 50 + 2 = 20 (battle_lib.c:6674–7078).
    expect(calcMoveDamage(v, deps(), M.TACKLE, v.sideConditionsMask[0], v.fieldConditionsMask, 0, TYPE_NORMAL, AI, PLAYER, 1)).toBe(20);
    // TrainerAI_CalcDamage's default case (trainer_ai.c:3074–3091), then STAB 30 and Normal into Rock: Divide(30 * 5, 10).
    expect(estimate(v, deps(), M.TACKLE, 100)).toBe(15);
  });

  it.each<[string, AiView, number, number, number]>([
    // Fixed damage under IGNORE_TYPE_CHECKS (:3093): no STAB and no chart scaling, though Dragon into Dragon is super effective.
    ['Dragon Rage is 40 (trainer_ai.c:3005–3006)', view({}, { types: [TYPE_DRAGON, TYPE_DRAGON] }), M.DRAGON_RAGE, 100, 40],
    ['the variance still applies: Divide(40 * 85, 100) (:3109)', view(), M.DRAGON_RAGE, 85, 34],
    ['Seismic Toss is the level (:3009–3011)', view({ level: 47 }), M.SEISMIC_TOSS, 100, 47],
    // The rows after the separator (battle_lib.c:2511–2514) still set INEFFECTIVE (:7551–7555), so 0 (trainer_ai.c:3106).
    ['fixed damage into an immune type is 0', view({}, { types: [TYPE_GHOST, TYPE_GHOST] }), M.SEISMIC_TOSS, 100, 0],
    ['super effective, then immune, is 0', view({}, { types: [TYPE_ELECTRIC, TYPE_FLYING] }), M.EARTHQUAKE, 100, 0],
    // power = 1 + 25 * monSpeedValues[defender] / monSpeedValues[attacker] (:2996); Steel into Electric halves it.
    ['Gyro Ball: 1 + 25 * 90 / 122 = 19 → 14 → 7', view(), MOVE_GYRO_BALL, 100, 7],
    ['Gyro Ball reads the cached speeds: 1 + 25 * 244 / 122 = 51 → 36 → 18', view({}, {}, { monSpeedValues: [244, 122, 0, 0] }), MOVE_GYRO_BALL, 100, 18],
  ])('%s', (_, v, move, variance, expected) => {
    expect(estimate(v, deps(), move, variance)).toBe(expected);
  });

  it('Psywave enumerates 11 values, unchanged by the chart', () => {
    expect(leavesOf(view(), deps(), M.PSYWAVE)).toEqual(PSYWAVE);
  });

  it("move 149 takes the Psywave path, whatever the hack's record says (trainer_ai.c:2884, 3014)", () => {
    const d = deps();
    d.moves[149] = { ...d.moves[149]!, category: 'physical', type: TYPE_ICE, power: 20, accuracy: 90, pp: 10 };
    expect(leavesOf(view({ types: [TYPE_ICE, TYPE_ICE] }), d, 149)).toEqual(PSYWAVE);
  });

  it('Magnitude buckets RandNext() % 100 into seven powers (trainer_ai.c:3030–3046)', () => {
    // Powers 10, 30, 50, 70, 90, 110, 150 → 150 * p * 22 / 99 / 50 + 2, then STAB and Ground into Electric (× 3).
    expect(leavesOf(view(), deps(), M.MAGNITUDE)).toEqual(
      leaves([24, 66, 104, 144, 186, 224, 306], [3280n, 6560n, 13120n, 19651n, 13100n, 6550n, 3275n]),
    );
  });

  it('a carried-over IGNORE_TYPE_CHECKS is refused (trainer_ai.c:3104, battle_lib.c:2009)', () => {
    expect(() => estimate(view({}, {}, { battleStatusMask: SYSCTL_IGNORE_TYPE_CHECKS }), deps(), M.TACKLE, 100)).toThrow(code('UNSUPPORTED'));
  });
});

describe('aiCalcAllDamage', () => {
  // Tackle: 150 * 35 * 22 / 99 / 50 + 2 = 25; no STAB, neutral. Then an empty slot, Protect (power 0) and an empty slot.
  const TACKLE_DAMAGE = 25;
  const all = (v: AiView, lat = latents(), varyDamage = false, pick: Pick = noPick) => {
    const mon = v.mons[AI];
    return aiCalcAllDamage(v, deps(), lat, AI, PLAYER, [M.TACKLE, 0, M.PROTECT, 0], mon.heldItem, mon.ivs, AI, mon.ability,
      mon.effects.embargoTurns, varyDamage, pick);
  };

  it('USE_MAX_DAMAGE makes no draw: the max of the slots (trainer_ai.c:2832, 2842–2846)', () => {
    expect(all(view())).toEqual({ max: TACKLE_DAMAGE, values: [TACKLE_DAMAGE, 0, 0, 0] });
  });

  it('rolls are drawn once per damaging slot, lazily, and shared across calls', () => {
    const v = view();
    const run = (pick: Pick) => {
      let picks = 0;
      const lat = latents();
      const counted: Pick = (weights) => {
        picks++;
        return pick(weights);
      };
      return { first: all(v, lat, true, counted), second: all(v, lat, true, counted), rolls: [...lat.rolls], picks };
    };
    // moveDamageRolls[0] = 100 - RandNext() % 16 (trainer_ai.c:240), then Divide(25 * roll, 100) (:3109).
    expect(enumerate(run, (r) => JSON.stringify(r))).toEqual(Array.from({ length: 16 }, (_, i) => {
      const damage = Math.trunc((TACKLE_DAMAGE * (100 - i)) / 100);
      const result = { max: damage, values: [damage, 0, 0, 0] };
      return { value: { first: result, second: result, rolls: [100 - i, null, null, null], picks: 1 }, probability: rat(4096, 65536) };
    }));
  });
});
