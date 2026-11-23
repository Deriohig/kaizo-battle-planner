// The opcodes that read abilities, held items and what the AI knows of the player's battler (AIContext.battlerMoves,
// battlerAbilities, battlerHeldItems). The AI's Garchomp has Sand Veil and Leftovers; the player's Luxray has Rivalry
// and a Sitrus Berry, and its species has Rivalry and Intimidate.

import { describe, expect, it } from 'vitest';
import {
  ABILITY_ARENA_TRAP, ABILITY_KLUTZ, ABILITY_LEVITATE, ABILITY_MAGNET_PULL, ABILITY_SHADOW_TAG, AI_HAVE, AI_NOT_HAVE,
  AI_UNKNOWN, FIELD_CONDITION_GRAVITY, MOVE_EFFECT_ABILITY_SUPPRESSED,
} from '../../../src/ai/constants.js';
import type { Pick } from '../../../src/ai/enumerate.js';
import { rat } from '../../../src/ai/odds.js';
import { FX, fixtureDeps, fixtureView } from './fixtures.js';
import {
  AI, ATK, ATK_PARTNER, branches, DEF, DEF_PARTNER, knows, loads, mon, oddsOf, PLAYER,
} from './opsHarness.js';

const M = FX.move;
const I = FX.item;
const A = FX.ability;
/** Hold effects of the fixture's items. */
const LEFTOVERS_EFFECT = 69;
const SITRUS_EFFECT = 13;
const QUICK_CLAW_EFFECT = 52;
const SUPPRESSED = MOVE_EFFECT_ABILITY_SUPPRESSED;

const knowsAbility = (ability: number, b = PLAYER) => knows({ battlerAbilities: { [b]: ability } });
const knowsItem = (item: number, b = PLAYER) => knows({ battlerHeldItems: { [b]: item } });
const knowsMove = (move: number, b = PLAYER) => knows({ battlerMoves: { [b]: [move, 0, 0, 0] } });
const gyarados = mon(PLAYER, { species: FX.species.GYARADOS, ability: A.INTIMIDATE }); // Intimidate, no second ability
const ability = (a: number) => mon(PLAYER, { ability: a });

describe('ability opcodes', () => {
  // A coin that checks it is RandNext() & 1 and lands on `side`.
  const coin = (side: number): Pick => (weights) => {
    expect(weights).toEqual([32768n, 32768n]);
    return side;
  };
  const poisonPoint = fixtureDeps();
  poisonPoint.species[FX.species.LUXRAY] = { ...poisonPoint.species[FX.species.LUXRAY]!, abilities: [0, A.POISON_POINT] };

  loads([
    // The attacker and its partner: the real ability (trainer_ai.c:1179, 1207–1208); the empty slot has none.
    [`LoadBattlerAbility ${ATK}`, A.SAND_VEIL],
    [`LoadBattlerAbility ${ATK_PARTNER}`, 0, { k: knowsAbility(A.INTIMIDATE, 3) }],
    // The other side: the known ability (:1179–1182), else the species' (:1191–1203); the empty slot's is none.
    [`LoadBattlerAbility ${DEF_PARTNER}`, A.INTIMIDATE, { k: knowsAbility(A.INTIMIDATE, 2) }],
    [`LoadBattlerAbility ${DEF_PARTNER}`, 0],
    // Two abilities, nothing known: an odd RandNext() & 1 gives ability 1, an even one ability 2 (:1194–1199).
    [`LoadBattlerAbility ${DEF}`, A.RIVALRY, { pick: coin(1) }],
    [`LoadBattlerAbility ${DEF}`, A.INTIMIDATE, { pick: coin(0) }],
    // One ability: that one with no draw (:1200–1203), the second one if only it is set.
    [`LoadBattlerAbility ${DEF}`, A.INTIMIDATE, { v: gyarados }],
    [`LoadBattlerAbility ${DEF}`, A.POISON_POINT, { d: poisonPoint }],
    [`LoadBattlerAbility ${DEF}`, A.INTIMIDATE, { k: knowsAbility(A.INTIMIDATE) }], // known, whatever the real one is
    // A real trapping ability is self-announced with no draw (:1185–1188), but a known ability comes first (:1181).
    [`LoadBattlerAbility ${DEF}`, ABILITY_ARENA_TRAP, { v: ability(ABILITY_ARENA_TRAP) }],
    [`LoadBattlerAbility ${DEF}`, ABILITY_SHADOW_TAG, { v: ability(ABILITY_SHADOW_TAG) }],
    [`LoadBattlerAbility ${DEF}`, ABILITY_MAGNET_PULL, { v: ability(ABILITY_MAGNET_PULL) }],
    [`LoadBattlerAbility ${DEF}`, A.INTIMIDATE, { v: ability(ABILITY_ARENA_TRAP), k: knowsAbility(A.INTIMIDATE) }],
    // Gastro Acid loads ABILITY_NONE before anything else, known or not (:1177–1178).
    [`LoadBattlerAbility ${DEF}`, 0, { v: mon(PLAYER, { moveEffectsMask: SUPPRESSED }), k: knowsAbility(A.INTIMIDATE) }],
    [`LoadBattlerAbility ${ATK}`, 0, { v: mon(AI, { moveEffectsMask: SUPPRESSED }) }],
    // CheckBattlerAbility: HAVE or NOT_HAVE (:1261–1265), and AI_UNKNOWN for no ability (:1259–1260).
    [`CheckBattlerAbility ${DEF}, ${A.INTIMIDATE}`, AI_UNKNOWN, { v: mon(PLAYER, { moveEffectsMask: SUPPRESSED }), k: knowsAbility(A.INTIMIDATE) }],
    [`CheckBattlerAbility ${ATK}, ${A.SAND_VEIL}`, AI_HAVE], // the attacker's real ability (:1255–1256)
    [`CheckBattlerAbility ${ATK}, ${A.RIVALRY}`, AI_NOT_HAVE],
    [`CheckBattlerAbility ${ATK_PARTNER}, ${A.SAND_VEIL}`, AI_UNKNOWN],
    [`CheckBattlerAbility ${DEF}, ${A.INTIMIDATE}`, AI_HAVE, { k: knowsAbility(A.INTIMIDATE) }], // known (:1225–1227)
    [`CheckBattlerAbility ${DEF}, ${A.RIVALRY}`, AI_NOT_HAVE, { k: knowsAbility(A.INTIMIDATE) }],
    [`CheckBattlerAbility ${DEF}, ${A.INTIMIDATE}`, AI_HAVE, { v: gyarados }], // one ability (:1248–1249)
    [`CheckBattlerAbility ${DEF}, ${A.SAND_VEIL}`, AI_NOT_HAVE, { v: gyarados }],
    [`CheckBattlerAbility ${DEF}, ${ABILITY_ARENA_TRAP}`, AI_HAVE, { v: ability(ABILITY_ARENA_TRAP) }], // :1230–1233
    [`CheckBattlerAbility ${DEF_PARTNER}, 0`, AI_UNKNOWN], // SPECIES_NONE's ability 2, none (:1250–1251)
    // Two abilities with no draw: neither asked about gives ability 1 (:1242–1243); either one gives none (:1245–1246).
    [`CheckBattlerAbility ${DEF}, ${A.SAND_VEIL}`, AI_NOT_HAVE],
    [`CheckBattlerAbility ${DEF}, ${A.RIVALRY}`, AI_UNKNOWN],
    [`CheckBattlerAbility ${DEF}, ${A.INTIMIDATE}`, AI_UNKNOWN],
    // LoadAbility is Battler_Ability (trainer_ai.c:2661): the real one, with Gastro Acid and Gravity on Levitate giving
    // none (battle_lib.c:3090–3095).
    [`LoadAbility ${DEF}`, A.RIVALRY, { k: knowsAbility(A.INTIMIDATE) }],
    [`LoadAbility ${ATK}`, A.SAND_VEIL],
    [`LoadAbility ${DEF}`, 0, { v: mon(PLAYER, { moveEffectsMask: SUPPRESSED }) }],
    [`LoadAbility ${DEF}`, ABILITY_LEVITATE, { v: ability(ABILITY_LEVITATE) }],
    [`LoadAbility ${DEF}`, 0, { v: mon(PLAYER, { ability: ABILITY_LEVITATE }, fixtureView({ fieldConditionsMask: FIELD_CONDITION_GRAVITY })) }],
  ]);

  it('an unknown ability flips on each call', () => {
    // Two loads, each adding 1 on Rivalry: each draws its own RandNext() & 1 (trainer_ai.c:1194–1199).
    const src = [
      `LoadBattlerAbility ${DEF}`, `IfLoadedEqualTo ${A.RIVALRY}, Add1`,
      `Next: LoadBattlerAbility ${DEF}`, `IfLoadedEqualTo ${A.RIVALRY}, Add2`, 'PopOrEnd',
      'Add1: AddToMoveScore 1', 'GoTo Next',
      'Add2: AddToMoveScore 1', 'PopOrEnd',
    ].join('\n');
    expect(oddsOf(src)).toEqual({ 100: rat(1, 4), 101: rat(1, 2), 102: rat(1, 4) });
  });
});

describe('item opcodes', () => {
  const claw = { heldItem: I.QUICK_CLAW, ability: ABILITY_KLUTZ };
  loads([
    // The raw battleMons[battler].heldItem (trainer_ai.c:1898), whatever is known; Embargo and Klutz don't apply.
    [`LoadHeldItem ${DEF}`, I.SITRUS_BERRY, { k: knowsItem(I.LEFTOVERS) }],
    [`LoadHeldItem ${ATK}`, I.LEFTOVERS],
    [`LoadHeldItem ${DEF}`, I.SITRUS_BERRY, { v: mon(PLAYER, { ability: ABILITY_KLUTZ, effects: { embargoTurns: 3 } }) }],
    // The attacker's real item's hold effect, any other battler's known item's (trainer_ai.c:1908–1911).
    [`LoadHeldItemEffect ${ATK}`, LEFTOVERS_EFFECT],
    [`LoadHeldItemEffect ${DEF}`, 0],
    [`LoadHeldItemEffect ${DEF}`, LEFTOVERS_EFFECT, { k: knowsItem(I.LEFTOVERS) }],
    [`LoadHeldItemEffect ${DEF}`, SITRUS_EFFECT, { k: knowsItem(I.SITRUS_BERRY) }],
    [`LoadHeldItemEffect ${ATK_PARTNER}`, QUICK_CLAW_EFFECT, { k: knowsItem(I.QUICK_CLAW, 3) }],
    // Battler_ItemFlingPower (trainer_ai.c:2021, battle_lib.c:5491–5493): the real item's, no Klutz check, 0 under Embargo.
    [`LoadFlingPower ${DEF}`, 80, { v: mon(PLAYER, claw) }],
    [`LoadFlingPower ${ATK}`, 10],
    [`LoadFlingPower ${DEF}`, 0, { v: mon(PLAYER, { ...claw, effects: { embargoTurns: 2 } }) }],
  ]);

  branches([
    // The AI's side: the real item (trainer_ai.c:1925–1926); the other side: only the known item (:1927–1928).
    [`IfHeldItemEqualTo ${ATK}, ${I.LEFTOVERS}, Taken`, true],
    [`IfHeldItemEqualTo ${ATK}, ${I.SITRUS_BERRY}, Taken`, false],
    [`IfHeldItemEqualTo ${ATK_PARTNER}, 0, Taken`, true, { k: knowsItem(I.LEFTOVERS, 3) }],
    [`IfHeldItemEqualTo ${DEF_PARTNER}, ${I.QUICK_CLAW}, Taken`, true, { k: knowsItem(I.QUICK_CLAW, 2) }],
    [`IfHeldItemEqualTo ${DEF}, ${I.LEFTOVERS}, Taken`, true, { k: knowsItem(I.LEFTOVERS) }], // real Sitrus Berry
    [`IfHeldItemEqualTo ${DEF}, ${I.LEFTOVERS}, Taken`, false, { v: mon(PLAYER, { heldItem: I.LEFTOVERS }) }],
    [`IfHeldItemEqualTo ${DEF}, ${I.LEFTOVERS}, Taken`, false, { v: mon(PLAYER, { heldItem: I.LEFTOVERS }), k: knowsItem(I.SITRUS_BERRY) }],
  ]);
});

describe('knowledge opcodes', () => {
  const partnerUp = mon(3, { curHP: 1 });
  branches([
    // The attacker: its real moves (trainer_ai.c:1638–1648); the defender: only what the AI has seen (:1666–1676).
    [`IfMoveKnown ${ATK}, ${M.EARTHQUAKE}, Taken`, true],
    [`IfMoveKnown ${ATK}, ${M.SPARK}, Taken`, false],
    [`IfMoveKnown ${DEF}, ${M.SPARK}, Taken`, false],
    [`IfMoveKnown ${DEF}, ${M.SPARK}, Taken`, true, { k: knowsMove(M.SPARK) }],
    // The attacker's partner: nothing at 0 HP (:1651–1653), else its real moves, all 0 in the empty slot.
    [`IfMoveKnown ${ATK_PARTNER}, 0, Taken`, false],
    [`IfMoveKnown ${ATK_PARTNER}, 0, Taken`, true, { v: partnerUp }],
    [`IfMoveKnown ${DEF_PARTNER}, ${M.SPARK}, Taken`, false, { k: knowsMove(M.SPARK, 2) }], // no case (:1678–1679)
    [`IfMoveNotKnown ${ATK}, ${M.SPARK}, Taken`, true], // trainer_ai.c:1694–1735
    [`IfMoveNotKnown ${ATK}, ${M.EARTHQUAKE}, Taken`, false],
    [`IfMoveNotKnown ${DEF}, ${M.SPARK}, Taken`, true],
    [`IfMoveNotKnown ${DEF}, ${M.SPARK}, Taken`, false, { k: knowsMove(M.SPARK) }],
    [`IfMoveNotKnown ${ATK_PARTNER}, ${M.SPARK}, Taken`, false],
    [`IfMoveNotKnown ${ATK_PARTNER}, ${M.SPARK}, Taken`, true, { v: partnerUp }],
    [`IfMoveNotKnown ${DEF_PARTNER}, ${M.SPARK}, Taken`, false],
    // Crunch's effect is 69, Spark's 6 (trainer_ai.c:1750–1819). Empty slots never match, not even effect 0, and
    // neither partner has a case.
    [`IfMoveEffectKnown ${ATK}, 69, Taken`, true],
    [`IfMoveEffectKnown ${ATK}, 6, Taken`, false],
    [`IfMoveEffectKnown ${DEF}, 6, Taken`, false],
    [`IfMoveEffectKnown ${DEF}, 6, Taken`, true, { k: knowsMove(M.SPARK) }],
    [`IfMoveEffectKnown ${DEF}, 0, Taken`, false],
    [`IfMoveEffectKnown ${ATK_PARTNER}, 69, Taken`, false, { v: mon(3, { curHP: 1, moves: [M.CRUNCH, 0, 0, 0] }) }],
    [`IfMoveEffectNotKnown ${ATK}, 6, Taken`, true],
    [`IfMoveEffectNotKnown ${ATK}, 69, Taken`, false],
    [`IfMoveEffectNotKnown ${DEF}, 6, Taken`, true],
    [`IfMoveEffectNotKnown ${DEF}, 6, Taken`, false, { k: knowsMove(M.SPARK) }],
    [`IfMoveEffectNotKnown ${DEF}, 0, Taken`, true],
    [`IfMoveEffectNotKnown ${ATK_PARTNER}, 6, Taken`, false],
  ]);
});
