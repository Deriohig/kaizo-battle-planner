// Which moves' battle scripts can leave battleStatusMask's type-chart bits (S_MASK) or powerMul (S_POWER) set.

import { expect, it } from 'vitest';
import {
  BATTLE_EFFECT_HIT_BEFORE_SWITCH, BATTLE_EFFECT_SWITCH_HIT, HACK_CHANGED_EFFECTS, S_MASK_EFFECTS, S_POWER_EFFECTS,
  VANILLA_MASK_EFFECTS, VANILLA_POWER_EFFECTS,
} from '../../../src/ai/battleScripts.js';
import {
  BATTLE_EFFECT_BIDE, BATTLE_EFFECT_FLY, BATTLE_EFFECT_LEVEL_DAMAGE_FLAT, BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN,
} from '../../../src/ai/constants.js';

it.each<[string, number, boolean, boolean]>([
  ['a fixed-damage move sets IGNORE_TYPE_CHECKS (effect_script_0087.s:5)', BATTLE_EFFECT_LEVEL_DAMAGE_FLAT, true, false],
  ['a charge move sets LAST_OF_MULTI_TURN (subscript_charge_move_cleanup.s:7)', BATTLE_EFFECT_FLY, true, false],
  ['so does Solar Beam', BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN, true, false],
  ['and Bide (subscript_bide_end.s:12)', BATTLE_EFFECT_BIDE, true, false],
  ['Revenge writes powerMul (battle_script.c:6531–6533)', 185, false, true],
  ["U-turn writes it through Pursuit's TryPursuit (:6928)", BATTLE_EFFECT_SWITCH_HIT, false, true],
  ['a plain hit writes neither', 0, false, false],
  ['nor does Baton Pass', 127, false, false],
  ['nor Pursuit itself', BATTLE_EFFECT_HIT_BEFORE_SWITCH, false, false],
])('%s', (_, effect, mask, power) => {
  expect([S_MASK_EFFECTS.has(effect), S_POWER_EFFECTS.has(effect)]).toEqual([mask, power]);
});

it("every effect whose script the hack changed joins both sets, on top of vanilla's", () => {
  expect([...HACK_CHANGED_EFFECTS].every((effect) => S_MASK_EFFECTS.has(effect) && S_POWER_EFFECTS.has(effect))).toBe(true);
  // 88 and 48 were in vanilla's sets already.
  expect([VANILLA_MASK_EFFECTS.length, VANILLA_POWER_EFFECTS.length, S_MASK_EFFECTS.size, S_POWER_EFFECTS.size]).toEqual([24, 19, 28, 23]);
});
