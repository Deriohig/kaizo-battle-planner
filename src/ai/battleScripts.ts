// What the battle's own scripts leave in the two BattleContext fields BattleAI_PostKOSwitchIn reads besides the
// battlers (final fix wave, item 1): battleStatusMask's bits that its type chart reads, and powerMul.
//
// Stage 1 and stage 2 of the post-KO pick (choose/postKo.ts) read three battleStatusMask bits: SYSCTL_IGNORE_TYPE_CHECKS
// (STAB, battle_lib.c:2592; the chart, :7544; the ability and item modifiers, :2655), SYSCTL_IGNORE_IMMUNITIES (:2656,
// :7545) and SYSCTL_LAST_OF_MULTI_TURN (MoveIsOnDamagingTurn, :7601, for Wonder Guard at :2650 and :2737). Stage 2
// multiplies every move's power by powerMul (:6688).
//
// When they are reset (pret/pokeplatinum 62bdaacdc). BattleContext_Init (battle_lib.c:1974) sets powerMul to 10 (:1980)
// and clears the three bits (`&= SYSCTL_INIT`, :2009; system_control.h:31–40). It runs at the end of EVERY action,
// BattleControllerPlayer_MoveEnd (battle_controller_player.c:3998), not only at the turn's end (:1855). So:
// - At an enemy replacement (TurnEnd's ReplaceFainted, battle_controller_player.c:1848), the last action's MoveEnd has
//   reset both. Only the turn-end checks run after it (field, mon and side conditions), and none of their scripts can
//   write them: the writers are the effect scripts below, subscript_bide_end and subscript_charge_move_cleanup (the
//   bits) and subscript_pursuit's TryPursuit (powerMul), which only a move's action reaches, and in the hack's changed
//   turn-end subscripts no writer at all (test/real/aiBattleScripts.test.ts). The adapter's 0 and 10 are exact there.
// - At the AI's own mid-turn switch (U-turn, Baton Pass), the switch is inside the switching move's script, before its
//   MoveEnd (subscript_attack_then_switch_out.s, subscript_baton_pass.s, then subscript_show_party_list.s's ShowParty).
//   That action's moves may have written them: the adapter lists them when one of its moves' effects is in a set below.
//
// The sets are built from the decompilation (res/battle/scripts, effect_script_NNNN.s for effect NNNN): an effect is in
// a set when its script, any subscript it reaches by Call, GoToSubscript or a side-effect pointer
// (include/data/move_side_effect_subscripts.h), or a C command handler it runs writes the field. Then the hack: its
// battle-script NARCs (battle/skill/be_seq.narc for the effects, sub_seq.narc for the subscripts) were compared member by
// member with vanilla's. Every effect whose own script differs joins BOTH sets, as does any effect that can reach a
// differing subscript (none can). This over-approximates, so it is sound. waza_seq.narc, each move's entry script
// (GoToEffectScript, battle_script.c:2084), is identical in both ROMs.

import { BATTLE_EFFECT_BIDE } from './constants.js';

/**
 * Effects whose script writes SYSCTL_IGNORE_TYPE_CHECKS, SYSCTL_IGNORE_IMMUNITIES or SYSCTL_LAST_OF_MULTI_TURN (vanilla).
 * - IGNORE_TYPE_CHECKS, set in the effect script itself (`UpdateVar OPCODE_FLAG_ON, BTLVAR_BATTLE_CTX_STATUS`): 40
 *   (Super Fang), 41 (Dragon Rage), 87 (Seismic Toss, Night Shade), 88 (Psywave), 89 (Counter), 130 (Sonic Boom), 144
 *   (Mirror Coat), 189 (Endeavor), 227 (Metal Burst).
 * - IGNORE_IMMUNITIES, likewise: 113 (Foresight, Odor Sleuth), 122 (Present), 148 (Future Sight, Doom Desire), 154
 *   (Beat Up), 216 (Miracle Eye).
 * - LAST_OF_MULTI_TURN, from subscript_charge_move_cleanup.s:7, which these call: 39 (Razor Wind), 75 (Sky Attack), 145
 *   (Skull Bash), 151 (Solar Beam), 155 (Fly), 255 (Dive), 256 (Dig), 263 (Bounce), 272 (Shadow Force); and from
 *   subscript_bide_end.s:12, which the C loads in Bide's own action (battle_controller_player.c:2720): 26 (Bide).
 * Effects 7 and 168 (Self-Destruct, Memento) OR a variable into the mask, `0x10000000 << attacker`: the self-destructed
 * bits 28–31 only. No C code sets the three bits (trainer_ai.c:3093 sets one and clears it at :3104).
 */
export const VANILLA_MASK_EFFECTS: readonly number[] = Object.freeze([
  BATTLE_EFFECT_BIDE, 39, 40, 41, 75, 87, 88, 89, 113, 122, 130, 144, 145, 148, 151, 154, 155, 189, 216, 227, 255, 256,
  263, 272,
]);

/**
 * Effects whose script writes powerMul (vanilla).
 * - `UpdateVar OPCODE_SET, BTLVAR_POWER_MULTI` in the effect script: 45 and 48, 198, 253, 262, 269 (the recoil moves'
 *   Reckless 12); 126 (generated name PSYWAVE; its script doubles against a Dig user), 146, 147, 149, 150, 257, 261
 *   (Twister, Earthquake, Gust, Stomp, Surf, Whirlpool: the doublers against Fly, Dig, Minimize and Dive); 169
 *   (Facade), 171 (SmellingSalt), 217 (Wake-Up Slap), 221 (Brine). Payback is no writer: no Gen 4 script or handler
 *   but these writes powerMul.
 * - The C: 185 (Revenge, Avalanche) runs CalcRevengePowerMul (battle_script.c:6525–6533); 228 (U-turn) calls
 *   subscript_pursuit (subscript_attack_then_switch_out.s:54), whose TryPursuit sets 20 (battle_script.c:6928).
 */
export const VANILLA_POWER_EFFECTS: readonly number[] = Object.freeze([
  45, 48, 126, 146, 147, 149, 150, 169, 171, 185, 198, 217, 221, 228, 253, 257, 261, 262, 269,
]);

/**
 * The hack's be_seq.narc members that differ from vanilla's: 48 (its recoil now goes through side-effect pointer 138),
 * 88 (now a three-hit script), 104 (Triple Kick's, now reading the move's power), 141 (unused in vanilla, now a
 * hit-during-Fly confusing move) and 182 (Superpower's, now a recoil move's). Checked by test/real/aiBattleScripts.
 */
export const HACK_CHANGED_EFFECTS: readonly number[] = Object.freeze([48, 88, 104, 141, 182]);

/**
 * The hack's sub_seq.narc members that differ from vanilla's: 238 (subscript_gravity_end) and 251
 * (subscript_trick_room_end), which the turn-end field check loads (battle_controller_player.c:1232, 1826), and 297,
 * which vanilla doesn't have (the switch-in field effect, docs/ai-spot-checks.md item 2). No effect script reaches
 * them, and none of them writes either field. Checked by test/real/aiBattleScripts.
 */
export const HACK_CHANGED_SUBSCRIPTS: readonly number[] = Object.freeze([238, 251, 297]);

/** S_mask: the effects whose action can leave an AI-read battleStatusMask bit set, in the hack (vanilla's ∪ changed). */
export const S_MASK_EFFECTS: ReadonlySet<number> = new Set([...VANILLA_MASK_EFFECTS, ...HACK_CHANGED_EFFECTS]);

/** S_power: the effects whose action can leave powerMul other than 10, in the hack (vanilla's ∪ changed). */
export const S_POWER_EFFECTS: ReadonlySet<number> = new Set([...VANILLA_POWER_EFFECTS, ...HACK_CHANGED_EFFECTS]);

/**
 * BATTLE_EFFECT_SWITCH_HIT (U-turn): in S_power only through subscript_pursuit, which runs before the AI picks its
 * switch-in (subscript_attack_then_switch_out.s:54, then :71 and ShowParty). TryPursuit writes powerMul only when a
 * foe that has not acted yet chose a BATTLE_EFFECT_HIT_BEFORE_SWITCH move (battle_script.c:6898–6928, the effect test at
 * :6915), and then its Pursuit hits the switching battler first: the adapter checks the engine's queue for that.
 */
export const BATTLE_EFFECT_SWITCH_HIT = 228;

/** Pursuit's effect, which TryPursuit looks for (battle_script.c:6915). */
export const BATTLE_EFFECT_HIT_BEFORE_SWITCH = 128;
