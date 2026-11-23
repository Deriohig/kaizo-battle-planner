// BattleSystem_CompareBattlerSpeed as the trainer AI calls it (ignoreQuickClaw = TRUE): Luxray (battler 0, Speed 90,
// Sitrus Berry) against Garchomp (battler 1, Speed 122, Leftovers).

import { describe, expect, it } from 'vitest';
import {
  ABILITY_SWIFT_SWIM, COMPARE_SPEED_FASTER as FASTER, COMPARE_SPEED_SLOWER as SLOWER, COMPARE_SPEED_TIE as TIE,
  FIELD_CONDITION_RAINING_TEMP, FIELD_CONDITION_TRICK_ROOM_0, MON_CONDITION_PARALYSIS, SIDE_CONDITION_TAILWIND_0,
} from '../../../src/ai/constants.js';
import { enumerate, type Pick } from '../../../src/ai/enumerate.js';
import { compareSpeed } from '../../../src/ai/lib/speed.js';
import { rat } from '../../../src/ai/odds.js';
import { AI_BATTLER as AI, type AiView, PLAYER_BATTLER as PLAYER } from '../../../src/ai/view.js';
import { FX, fixtureDeps, fixtureView } from './fixtures.js';
import { latents, noPick } from './miscHarness.js';

/** The fixture after `patch`. */
const view = (patch: (v: AiView) => void = () => {}) => {
  const v = fixtureView();
  patch(v);
  return v;
};
/** Garchomp holding Quick Claw (holdParam 20), too slow to move first otherwise: Speed 10 against 90. */
const quickClaw = (known: boolean | null) => view((v) => {
  Object.assign(v.mons[AI], { heldItem: FX.item.QUICK_CLAW, speed: 10 });
  v.quickClawThisTurn = [null, known, null, null];
});

/** The odds of each result of comparing `b1` with `b2` on `v`. */
function odds(v: AiView, b1: number, b2: number) {
  const leaves = enumerate((pick) => compareSpeed(v, fixtureDeps(), latents(), b1, b2, pick).result, String);
  return Object.fromEntries(leaves.map((leaf) => [leaf.value, leaf.probability]));
}

describe('compareSpeed', () => {
  // `speeds` is what battle_lib.c:1372–1373 write, battler 1's first.
  it.each<[string, AiView, number, number, number, [number, number]]>([
    ['faster: 122 > 90 at neutral stages (battle_lib.c:1225–1226, 1441)', view(), AI, PLAYER, FASTER, [122, 90]],
    ['slower (:1441–1443)', view(), PLAYER, AI, SLOWER, [90, 122]],
    ['paralysis quarters speed (:1259–1260)', view((v) => void (v.mons[AI].status = MON_CONDITION_PARALYSIS)), AI, PLAYER, SLOWER, [30, 90]],
    ['Trick Room reverses (:1432–1434)', view((v) => void (v.fieldConditionsMask = FIELD_CONDITION_TRICK_ROOM_0)), AI, PLAYER, SLOWER, [122, 90]],
    ['Trick Room reverses, the other way', view((v) => void (v.fieldConditionsMask = FIELD_CONDITION_TRICK_ROOM_0)), PLAYER, AI, FASTER, [90, 122]],
    ["Tailwind doubles the player's side (:1340–1341)", view((v) => void (v.sideConditionsMask = [SIDE_CONDITION_TAILWIND_0, 0])), AI, PLAYER, SLOWER, [122, 180]],
    ['Swift Swim without rain', view((v) => void (v.mons[PLAYER].ability = ABILITY_SWIFT_SWIM)), AI, PLAYER, FASTER, [122, 90]],
    ['Swift Swim in rain doubles (:1228, 1234–1236)', view((v) => {
      v.mons[PLAYER].ability = ABILITY_SWIFT_SWIM;
      v.fieldConditionsMask = FIELD_CONDITION_RAINING_TEMP;
    }), AI, PLAYER, SLOWER, [122, 180]],
    ['a known Quick Claw activation wins, whatever the speeds (:1410–1411)', quickClaw(true), AI, PLAYER, FASTER, [10, 90]],
    ['a known Quick Claw miss leaves the plain comparison', quickClaw(false), AI, PLAYER, SLOWER, [10, 90]],
  ])('%s', (_, v, b1, b2, result, speeds) => {
    expect(compareSpeed(v, fixtureDeps(), latents(), b1, b2, noPick)).toEqual({ result, speeds });
  });

  it('an exact tie draws a coin: FASTER unless RandNext() & 1 (battle_lib.c:1445–1446)', () => {
    expect(odds(view((v) => void (v.mons[PLAYER].speed = 122)), AI, PLAYER)).toEqual({ [FASTER]: rat(1, 2), [TIE]: rat(1, 2) });
  });

  it('an unknown Quick Claw is a latent drawn once per run (battle_lib.c:1279)', () => {
    // speedRand[1] % (100 / 20) == 0: 65536 = 5 * 13107 + 1, so residue 0 holds 13108 values.
    const fires = rat(13108, 65536);
    const misses = rat(65536 - 13108, 65536);
    expect(odds(quickClaw(null), AI, PLAYER)).toEqual({ [FASTER]: fires, [SLOWER]: misses });
    // Two comparisons in one run read the same draw: not (13108/65536)².
    const v = quickClaw(null);
    const run = (pick: Pick) => {
      const lat = latents();
      const results = [0, 1].map(() => compareSpeed(v, fixtureDeps(), lat, AI, PLAYER, pick).result);
      return `${results.join(',')}|${lat.quickClaw[AI]}`;
    };
    expect(Object.fromEntries(enumerate(run, String).map((leaf) => [leaf.value, leaf.probability]))).toEqual({
      [`${FASTER},${FASTER}|true`]: fires,
      [`${SLOWER},${SLOWER}|false`]: misses,
    });
  });
});
