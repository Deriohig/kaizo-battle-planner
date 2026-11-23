// Real-data check: every scoring rule in lhearachel's Gen 4 trainer AI gist
// (https://gist.github.com/lhearachel/ff61af1f58c84c96592b0b8184dba096) for every flag but Expert, run on the hack's
// own AI script and move data (gistCase, aiGistCases.ts). Each case checks the slot's exact score change and its odds.
//
// The decompilation's src/battle/trainer_ai/script.s (pret/pokeplatinum 62bdaacdc) is the source of truth; its line
// numbers match the hack's script word for word (docs/ai-changes.md). Where the gist and the script disagree, the case
// expects the script, and its comment says "Gist error" with the script line that wins. Where the hack differs, the case
// expects the hack and says "Hack:":
// - the one script change, Dry Skin in Basic's immunity check (script.s:78);
// - move data. Besides the AI Changes tab's moves (docs/ai-changes.md), the hack gives many moves new effects, and
//   leaves some effects on no move at all. A rule routed on such an effect can't fire in the hack: its case checks that
//   no move carries the effect (movesWithEffect), and what the moves the gist names do instead.
//
// Singles only: the AI (battler 1) always targets the player (battler 0), so IfTargetIsPartner never jumps
// (trainer_ai.c:2630–2639), and the script's partner codes name the empty slots, 3 for the AI's partner and 2 for the
// player's (AIScript_Battler, trainer_ai.c:2765–2780). Their HP is 0/0, which an IfHPPercent* reads as 0%: the
// cartridge's u32 divide returns the dividend for a zero divisor (`_u32_div_f`, ARM9 0x020E2178,
// udivCartridge), so the script takes an absent partner as fainted. CheckBattlerAbility on them gives AI_UNKNOWN.

import { describe, expect, it } from 'vitest';
import {
  AI_FLAG_BASIC, AI_FLAG_BATON_PASS, AI_FLAG_CHECK_HP, AI_FLAG_EVAL_ATTACK, AI_FLAG_HARRASSMENT,
  AI_FLAG_PRIORITIZE_EXTREMES, AI_FLAG_RISKY, AI_FLAG_SETUP_FIRST_TURN, AI_FLAG_TAG_STRATEGY, AI_FLAG_WEATHER,
  BATTLE_TYPE_FRONTIER_SINGLES, FIELD_CONDITION_DEEP_FOG, FIELD_CONDITION_GRAVITY_INIT, FIELD_CONDITION_HAILING_PERM,
  FIELD_CONDITION_RAINING_PERM, FIELD_CONDITION_SANDSTORM_PERM, FIELD_CONDITION_SUNNY_PERM,
  FIELD_CONDITION_TRICK_ROOM_INIT, GENDER_MALE, GENDER_NONE, MON_CONDITION_BURN, MON_CONDITION_PARALYSIS,
  MON_CONDITION_POISON, MON_CONDITION_TOXIC, MOVE_EFFECT_ABILITY_SUPPRESSED, MOVE_EFFECT_AQUA_RING,
  MOVE_EFFECT_CAMOUFLAGE, MOVE_EFFECT_EMBARGO, MOVE_EFFECT_IMPRISON, MOVE_EFFECT_IMPRISONED, MOVE_EFFECT_INGRAIN,
  MOVE_EFFECT_LEECH_SEED, MOVE_EFFECT_LOCK_ON_0, MOVE_EFFECT_MAGNET_RISE, MOVE_EFFECT_MIRACLE_EYE,
  MOVE_EFFECT_PERISH_SONG, MOVE_EFFECT_POWER_TRICK, SIDE_CONDITION_FUTURE_SIGHT, SIDE_CONDITION_LIGHT_SCREEN,
  SIDE_CONDITION_LUCKY_CHANT_0, SIDE_CONDITION_MIST, SIDE_CONDITION_REFLECT, SIDE_CONDITION_SAFEGUARD,
  SIDE_CONDITION_SPIKES, SIDE_CONDITION_STEALTH_ROCK, SIDE_CONDITION_TAILWIND_0, SIDE_CONDITION_TOXIC_SPIKES,
  TYPE_DARK, TYPE_ELECTRIC, TYPE_FIRE, TYPE_FLYING, TYPE_GHOST, TYPE_GRASS, TYPE_GROUND, TYPE_ICE, TYPE_NORMAL, TYPE_POISON,
  TYPE_PSYCHIC, TYPE_ROCK, TYPE_STEEL, VOLATILE_CONDITION_ATTRACT_0, VOLATILE_CONDITION_CONFUSION_0,
  VOLATILE_CONDITION_CURSE, VOLATILE_CONDITION_FOCUS_ENERGY, VOLATILE_CONDITION_FORESIGHT, VOLATILE_CONDITION_MEAN_LOOK,
  VOLATILE_CONDITION_NIGHTMARE, VOLATILE_CONDITION_SUBSTITUTE, VOLATILE_CONDITION_TORMENT,
} from '../../src/ai/constants.js';
import { A, E, type Expected, gistCase, type GistSetup, hackEffect, I, M, noHackMove, type StageName } from './aiGistCases.js';
import { needFiles, PK_ROM } from './env.js';

const suite = needFiles("the gist's scoring rules on the hack's AI script", { PK_ROM });

/** A sleep counter of 2: asleep (MON_CONDITION_SLEEP is the counter's 3 bits). */
const ASLEEP = 2;

// The odds of the flags' draws: `IfRandomLessThan n` jumps with n/256 (trainer_ai.c:528–538).
/** IfRandomLessThan 128 skips, else +2. */
const PLUS_2_HALF = '128/256: +2, 128/256: 0';
/** IfRandomLessThan 80 skips, else +2. */
const PLUS_2_OFTEN = '176/256: +2, 80/256: 0';
/** IfRandomLessThan 100 skips, else +2. */
const PLUS_2_EXTREMES = '156/256: +2, 100/256: 0';
/** IfRandomLessThan 51 skips, else -2. */
const MINUS_2_DEPRIORITIZE = '205/256: -2, 51/256: 0';
/** IfRandomLessThan 50 skips, else -2. */
const MINUS_2_CHECK_HP = '206/256: -2, 50/256: 0';

/** HP out of the default 200 for a percentage (curHP * 100 / maxHP, truncated, trainer_ai.c:596). */
const hp = (percent: number) => percent * 2;

describe.skipIf(suite.skip)(suite.title, () => {
  describe('Basic', () => {
    const b = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_BASIC, setup, expected);
    const safeguard: [number, number] = [SIDE_CONDITION_SAFEGUARD, 0];

    describe('Step 1: immunities', () => {
      it('1. immune to the move by its typing: -10', () => {
        b({ moves: [M.THUNDERBOLT], effect: E.PARALYZE_HIT }, '0');
        b({ moves: [M.THUNDERBOLT], player: { types: [TYPE_GROUND, TYPE_GROUND] } }, '-10'); // script.s:68
      });

      it('2. Volt Absorb, Motor Drive, Water Absorb, Flash Fire without Mold Breaker: -12', () => {
        // Gist error: the gist says -10; Basic_Check*Absorption go to ScoreMinus12 (script.s:83, 88, 93).
        b({ moves: [M.THUNDERBOLT], player: { ability: A.VOLT_ABSORB } }, '-12');
        b({ moves: [M.THUNDERBOLT], player: { ability: A.MOTOR_DRIVE } }, '-12');
        b({ moves: [M.HYDRO_PUMP], effect: E.HIT, player: { ability: A.WATER_ABSORB } }, '-12');
        b({ moves: [M.FLAMETHROWER], effect: E.BURN_HIT, player: { ability: A.FLASH_FIRE } }, '-12');
        b({ moves: [M.THUNDERBOLT], ai: { ability: A.MOLD_BREAKER }, player: { ability: A.VOLT_ABSORB } }, '0'); // script.s:70
      });

      it('2. Wonder Guard (anything not super effective) and Levitate (Ground): -10', () => {
        // The -10 comes from the type check (script.s:68), before the ability checks' -12: BattleSystem_ApplyTypeChart
        // flags a real Levitate holder MOVE_STATUS_LEVITATED and a Wonder Guard holder's non-super-effective hit
        // MOVE_STATUS_WONDER_GUARD (battle_lib.c:2600–2603, 2649–2654), which IfMoveEffectivenessEquals reads as
        // TYPE_MULTI_IMMUNE (trainer_ai.c:1339–1341).
        b({ moves: [M.EARTHQUAKE], effect: E.DOUBLE_DAMAGE_DIG, player: { ability: A.LEVITATE } }, '-10');
        b({ moves: [M.TACKLE], player: { ability: A.WONDER_GUARD } }, '-10');
        b({ moves: [M.BRICK_BREAK], effect: E.REMOVE_SCREENS, player: { ability: A.WONDER_GUARD } }, '0'); // super effective
      });

      it('2. Soundproof against a sound move: -10', () => {
        b({ moves: [M.GROWL], effect: E.ATK_DOWN, player: { ability: A.SOUNDPROOF } }, '-10'); // script.s:117–121
        b({ moves: [M.GROWL], ai: { ability: A.MOLD_BREAKER }, player: { ability: A.SOUNDPROOF } }, '0'); // script.s:120
      });

      it('2. note: Dry Skin is absent from the check (hack: fixed, -12 for a Water move)', () => {
        // Hack: the Dry Skin fix (docs/ai-changes.md). Vanilla tests Levitate twice at script.s:78; the hack's word there
        // is ABILITY_DRY_SKIN, so Basic_CheckWaterAbsorption2 runs. Mold Breaker skips it, as it skips the others.
        b({ moves: [M.HYDRO_PUMP], player: { ability: A.DRY_SKIN } }, '-12');
        b({ moves: [M.HYDRO_PUMP], ai: { ability: A.MOLD_BREAKER }, player: { ability: A.DRY_SKIN } }, '0');
        b({ moves: [M.THUNDERBOLT], player: { ability: A.DRY_SKIN } }, '0');
      });
    });

    describe('Step 2: move effects', () => {
      it('Sleep: a status, Safeguard, Insomnia or Vital Spirit: -10', () => {
        const sleep = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.HYPNOSIS], effect: E.STATUS_SLEEP, ...s });
        b(sleep(), '0');
        b(sleep({ player: { status: MON_CONDITION_PARALYSIS } }), '-10');
        b(sleep({ sides: safeguard }), '-10');
        b(sleep({ player: { ability: A.INSOMNIA } }), '-10');
        b(sleep({ player: { ability: A.VITAL_SPIRIT } }), '-10');
      });

      it('Poison: Steel or Poison, Immunity, Magic Guard, Poison Heal, Leaf Guard in sun, Hydration in rain, a status, Safeguard: -10', () => {
        const toxic = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.TOXIC], effect: E.STATUS_BADLY_POISON, ...s });
        b(toxic(), '0');
        b(toxic({ player: { types: [TYPE_STEEL, TYPE_STEEL] } }), '-10');
        b(toxic({ player: { types: [TYPE_NORMAL, TYPE_POISON] } }), '-10');
        for (const ability of [A.IMMUNITY, A.MAGIC_GUARD, A.POISON_HEAL]) b(toxic({ player: { ability } }), '-10');
        b(toxic({ player: { ability: A.LEAF_GUARD }, field: FIELD_CONDITION_SUNNY_PERM }), '-10');
        b(toxic({ player: { ability: A.LEAF_GUARD } }), '0');
        b(toxic({ player: { ability: A.HYDRATION }, field: FIELD_CONDITION_RAINING_PERM }), '-10');
        b(toxic({ player: { ability: A.HYDRATION } }), '0');
        b(toxic({ player: { status: MON_CONDITION_BURN } }), '-10');
        b(toxic({ sides: safeguard }), '-10');
        // Poison Powder's STATUS_POISON takes the same routine (script.s:179).
        b({ moves: [M.POISON_POWDER], effect: E.STATUS_POISON, player: { types: [TYPE_STEEL, TYPE_STEEL] } }, '-10');
      });

      it('Paralysis: immune by type, Limber, Magic Guard, Thunder Wave into Motor Drive or Volt Absorb, a status, Safeguard: -10', () => {
        const tw = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.THUNDER_WAVE], effect: E.STATUS_PARALYZE, ...s });
        b(tw(), '0');
        b(tw({ player: { types: [TYPE_GROUND, TYPE_GROUND] } }), '-10');
        b(tw({ player: { ability: A.LIMBER } }), '-10');
        b(tw({ player: { ability: A.MAGIC_GUARD } }), '-10');
        b(tw({ player: { ability: A.MOTOR_DRIVE } }), '-10');
        b(tw({ player: { ability: A.VOLT_ABSORB } }), '-10');
        b(tw({ player: { ability: A.VOLT_ABSORB }, ai: { ability: A.MOLD_BREAKER } }), '0'); // script.s:619
        b({ moves: [M.STUN_SPORE], effect: E.STATUS_PARALYZE, player: { ability: A.VOLT_ABSORB } }, '0'); // script.s:620
        b(tw({ player: { status: MON_CONDITION_POISON } }), '-10');
        b(tw({ sides: safeguard }), '-10');
      });

      it('Burn: Fire, Water Veil, Magic Guard, a status, Safeguard: -10', () => {
        const wisp = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.WILL_O_WISP], effect: E.STATUS_BURN, ...s });
        b(wisp(), '0');
        b(wisp({ player: { types: [TYPE_NORMAL, TYPE_FIRE] } }), '-10');
        b(wisp({ player: { ability: A.WATER_VEIL } }), '-10');
        b(wisp({ player: { ability: A.MAGIC_GUARD } }), '-10');
        b(wisp({ player: { status: MON_CONDITION_PARALYSIS } }), '-10');
        b(wisp({ sides: safeguard }), '-10');
      });

      it('Confusion: already confused -5; Own Tempo or Safeguard -10', () => {
        const ray = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.CONFUSE_RAY], effect: E.STATUS_CONFUSE, ...s });
        b(ray(), '0');
        b(ray({ player: { statusVolatile: VOLATILE_CONDITION_CONFUSION_0 } }), '-5');
        b(ray({ player: { ability: A.OWN_TEMPO } }), '-10');
        b(ray({ sides: safeguard }), '-10');
        // Swagger and Flatter take the same routine (script.s:201, 230).
        b({ moves: [M.SWAGGER], effect: E.ATK_UP_2_STATUS_CONFUSION, player: { ability: A.OWN_TEMPO } }, '-10');
        b({ moves: [M.FLATTER], effect: E.SP_ATK_UP_CAUSE_CONFUSION, player: { statusVolatile: VOLATILE_CONDITION_CONFUSION_0 } }, '-5');
      });

      it('Attract: infatuated, Oblivious, the same gender, a genderless target: -10', () => {
        const attract = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ATTRACT], effect: E.INFATUATE, ...s });
        b(attract(), '0'); // a male AI and a female target
        b(attract({ player: { statusVolatile: VOLATILE_CONDITION_ATTRACT_0 } }), '-10');
        b(attract({ player: { ability: A.OBLIVIOUS } }), '-10');
        b(attract({ player: { gender: GENDER_MALE } }), '-10');
        b(attract({ player: { gender: GENDER_NONE } }), '-10');
        b(attract({ ai: { gender: GENDER_NONE } }), '-10'); // a genderless attacker too (script.s:739)
      });

      it('Self-Destruct / Explosion: immune by type -10, Damp -10, last Pokémon -10, both last -1', () => {
        const boom = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.EXPLOSION], effect: E.HALVE_DEFENSE, ...s });
        b(boom(), '0');
        b(boom({ player: { types: [TYPE_GHOST, TYPE_GHOST] } }), '-10');
        b(boom({ player: { ability: A.DAMP } }), '-10');
        b(boom({ player: { ability: A.DAMP }, ai: { ability: A.MOLD_BREAKER } }), '0');
        b(boom({ aiBench: 0 }), '-10');
        b(boom({ aiBench: 0, playerBench: 0 }), '-1');
        b({ moves: [M.SELF_DESTRUCT], effect: E.HALVE_DEFENSE, player: { types: [TYPE_GHOST, TYPE_GHOST] } }, '-10');
      });

      it('Nightmare: under Nightmare or Magic Guard -10; awake -8 (hack: no move has the effect)', () => {
        // Hack: no move has STATUS_NIGHTMARE; the hack's move 171 is HP Ghost, a plain hit, so Basic leaves it be.
        noHackMove(E.STATUS_NIGHTMARE);
        b({
          moves: [M.NIGHTMARE], effect: E.HIT,
          player: { types: [TYPE_PSYCHIC, TYPE_PSYCHIC], status: ASLEEP, statusVolatile: VOLATILE_CONDITION_NIGHTMARE },
        }, '0');
      });

      it('Dream Eater: awake -8; immune by type -10', () => {
        const de = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.DREAM_EATER], effect: E.RECOVER_DAMAGE_SLEEP, ...s });
        b(de(), '-8');
        b(de({ player: { status: ASLEEP } }), '0');
        b(de({ player: { status: ASLEEP, types: [TYPE_DARK, TYPE_DARK] } }), '-10');
      });

      it('Belly Drum: under 51% HP (rounded down): -10', () => {
        // Gist error in the example: 178/350 HP is 50% (17800 / 350, truncated), so Belly Drum still gets -10;
        // 179/350 (51%) is the first HP that escapes IfHPPercentLessThan 51 (script.s:337).
        const drum = (curHP: number): GistSetup => ({ moves: [M.BELLY_DRUM], effect: E.MAX_ATK_LOSE_HALF_MAX_HP, ai: { hp: curHP, maxHP: 350 } });
        b(drum(177), '-10');
        b(drum(178), '-10');
        b(drum(179), '0');
        // It then falls into the Attack-boost checks (script.s:343).
        b({ moves: [M.BELLY_DRUM], ai: { stages: { attack: 6 } } }, '-10');
      });

      it('Stat boosts: +6 already: -10', () => {
        const boosts: [number, number, StageName][] = [
          [M.HOWL, E.ATK_UP, 'attack'], [M.HARDEN, E.DEF_UP, 'defense'], [M.GROWTH, E.SP_ATK_UP, 'spAttack'],
          [M.DOUBLE_TEAM, E.EVA_UP, 'evasion'], [M.SWORDS_DANCE, E.ATK_UP_2, 'attack'], [M.BARRIER, E.DEF_UP_2, 'defense'],
          [M.AGILITY, E.SPEED_UP_2, 'speed'], [M.NASTY_PLOT, E.SP_ATK_UP_2, 'spAttack'], [M.AMNESIA, E.SP_DEF_UP_2, 'spDefense'],
          [M.MINIMIZE, E.EVA_UP_2_MINIMIZE, 'evasion'],
        ];
        for (const [move, effect, stat] of boosts) {
          b({ moves: [move], effect, ai: { stages: { [stat]: 6 } } }, '-10');
          b({ moves: [move], effect, ai: { stages: { [stat]: 5 } } }, '0');
        }
        // Hack: no move raises Speed or Special Defense by one stage, or accuracy at all, or evasion by two without
        // Minimize's effect.
        noHackMove(E.SPEED_UP, E.SP_DEF_UP, E.ACC_UP, E.ACC_UP_2, E.EVA_UP_2);
      });

      it('Stat boosts: Simple at +3 or more: -10', () => {
        b({ moves: [M.HOWL], ai: { ability: A.SIMPLE, stages: { attack: 3 } } }, '-10'); // IfStatStageGreaterThan 8 (script.s:346)
        b({ moves: [M.HOWL], ai: { ability: A.SIMPLE, stages: { attack: 2 } } }, '0');
      });

      it('Stat boosts: Speed under Trick Room: -10', () => {
        b({ moves: [M.AGILITY], field: FIELD_CONDITION_TRICK_ROOM_INIT }, '-10');
      });

      it('Stat boosts: accuracy or evasion with No Guard: -10', () => {
        b({ moves: [M.DOUBLE_TEAM], ai: { ability: A.NO_GUARD } }, '-10');
        // The script also checks the target's No Guard first (script.s:408–409), which the gist leaves out.
        b({ moves: [M.DOUBLE_TEAM], player: { ability: A.NO_GUARD } }, '-10');
      });

      it('Stat drops: at -6 already: -10', () => {
        const drops: [number, number, StageName][] = [
          [M.GROWL, E.ATK_DOWN, 'attack'], [M.LEER, E.DEF_DOWN, 'defense'], [M.STRING_SHOT, E.SPEED_DOWN, 'speed'],
          [M.SAND_ATTACK, E.ACC_DOWN, 'accuracy'], [M.SWEET_SCENT, E.EVA_DOWN, 'evasion'], [M.CHARM, E.ATK_DOWN_2, 'attack'],
          [M.SCREECH, E.DEF_DOWN_2, 'defense'], [M.SCARY_FACE, E.SPEED_DOWN_2, 'speed'], [M.KINESIS, E.SP_DEF_DOWN_2, 'spDefense'],
        ];
        for (const [move, effect, stat] of drops) {
          b({ moves: [move], effect, player: { stages: { [stat]: -6 } } }, '-10');
          b({ moves: [move], effect, player: { stages: { [stat]: -5 } } }, '0');
        }
        // Hack: no move lowers Special Attack, Special Defense by one stage, or accuracy or evasion by two (whose
        // routines script.s:176–177 swap).
        noHackMove(E.SP_ATK_DOWN, E.SP_ATK_DOWN_2, E.SP_DEF_DOWN, E.EVA_DOWN_2, E.ACC_DOWN_2);
      });

      it('Stat drops: Speed under Trick Room: -10', () => {
        b({ moves: [M.STRING_SHOT], field: FIELD_CONDITION_TRICK_ROOM_INIT }, '-10');
      });

      it('Stat drops: Attack into Hyper Cutter: -10', () => {
        b({ moves: [M.GROWL], player: { ability: A.HYPER_CUTTER } }, '-10');
        b({ moves: [M.LEER], player: { ability: A.HYPER_CUTTER } }, '0');
      });

      it('Stat drops: Speed into Speed Boost: -10', () => {
        b({ moves: [M.STRING_SHOT], player: { ability: A.SPEED_BOOST } }, '-10');
        b({ moves: [M.SCARY_FACE], effect: E.SPEED_DOWN_2, player: { ability: A.SPEED_BOOST } }, '-10');
      });

      it('Stat drops: accuracy or evasion with No Guard on either side: -10', () => {
        for (const move of [M.SAND_ATTACK, M.SWEET_SCENT]) {
          b({ moves: [move], ai: { ability: A.NO_GUARD } }, '-10');
          b({ moves: [move], player: { ability: A.NO_GUARD } }, '-10');
        }
      });

      it('Stat drops: accuracy with Keen Eye: -10', () => {
        // Gist error: the gist says the attacker's Keen Eye; script.s:457–458 load the target's ability.
        b({ moves: [M.SAND_ATTACK], player: { ability: A.KEEN_EYE } }, '-10');
        b({ moves: [M.SAND_ATTACK], ai: { ability: A.KEEN_EYE } }, '0');
      });

      it('Stat drops: Clear Body or White Smoke: -10', () => {
        // Gist error: the gist says the attacker's; Basic_CheckClearBodyEffect loads the target's (script.s:470).
        b({ moves: [M.LEER], player: { ability: A.CLEAR_BODY } }, '-10');
        b({ moves: [M.LEER], player: { ability: A.WHITE_SMOKE } }, '-10');
        b({ moves: [M.LEER], ai: { ability: A.CLEAR_BODY } }, '0');
      });

      it('Stat stage resetting, copying, swapping: no lowered stage of ours and no raised stage of theirs: -10', () => {
        b({ moves: [M.HAZE], effect: E.RESET_STAT_CHANGES }, '-10');
        b({ moves: [M.HAZE], ai: { stages: { attack: -1 } } }, '0');
        b({ moves: [M.HAZE], player: { stages: { defense: 1 } } }, '0');
        b({ moves: [M.HAZE], ai: { stages: { evasion: -1 } } }, '0');
        b({ moves: [M.PSYCH_UP], effect: E.COPY_STAT_CHANGES }, '-10');
        b({ moves: [M.PSYCH_UP], player: { stages: { spAttack: 1 } } }, '0');
        noHackMove(E.SWAP_STAT_CHANGES); // Hack: Heart Swap (391) is a draining hit
      });

      it('Non-standard damage and charge turns: immune by type or ability: -10', () => {
        b({ moves: [M.NIGHT_SHADE], effect: E.LEVEL_DAMAGE_FLAT }, '-10'); // Ghost into a Normal type
        b({ moves: [M.SEISMIC_TOSS], effect: E.LEVEL_DAMAGE_FLAT, player: { types: [TYPE_GHOST, TYPE_GHOST] } }, '-10');
        b({ moves: [M.RAZOR_WIND], effect: E.CHARGE_TURN_HIGH_CRIT, player: { types: [TYPE_GHOST, TYPE_GHOST] } }, '-10');
        b({ moves: [M.COUNTER], effect: E.COUNTER, player: { types: [TYPE_GHOST, TYPE_GHOST] } }, '-10');
        b({ moves: [M.FLAIL], effect: E.INCREASE_POWER_WITH_LESS_HP, player: { types: [TYPE_GHOST, TYPE_GHOST] } }, '-10');
        b({ moves: [M.FOCUS_PUNCH], effect: E.HIT_LAST_WHIFF_IF_HIT, player: { types: [TYPE_GHOST, TYPE_GHOST] } }, '-10');
        // Hack: Superpower has effect 48, vanilla's RECOIL_QUARTER, which the hack gives the moves its Moves tab lists as
        // 1/2 recoil (docs/ai-changes.md); Take Down, Close Combat and Brave Bird carry Superpower's old effect,
        // LOWER_OWN_ATK_AND_DEF, into this routine (script.s:237).
        b({ moves: [M.CLOSE_COMBAT], effect: E.LOWER_OWN_ATK_AND_DEF, player: { types: [TYPE_GHOST, TYPE_GHOST] } }, '-10');
        b({ moves: [M.CLOSE_COMBAT] }, '0');
        b({ moves: [M.TAKE_DOWN], effect: E.LOWER_OWN_ATK_AND_DEF, player: { types: [TYPE_GHOST, TYPE_GHOST] } }, '-10');
        expect(hackEffect(M.SUPERPOWER)).toBe(E.RECOIL_QUARTER);
        // Hack: vanilla's recharge moves have effect 48 (RECOIL_QUARTER, which the Moves tab calls 1/2 recoil), so they
        // are damage-scored and their absorbing ability gives -12.
        b({ moves: [M.HYDRO_CANNON], effect: E.RECOIL_QUARTER, player: { ability: A.WATER_ABSORB } }, '-12');
        // Hack: no move charges with a Defense boost or flinches after a charge, recharges, or takes vanilla's Bide,
        // Return, Frustration or Wring Out effects; Magnitude's ID (222) is Bulldoze, with a Speed-drop hit.
        noHackMove(E.RECHARGE_AFTER, E.CHARGE_TURN_DEF_UP, E.CHARGE_TURN_HIGH_CRIT_FLINCH, E.BIDE,
          E.POWER_BASED_ON_FRIENDSHIP, E.POWER_BASED_ON_LOW_FRIENDSHIP, E.PSYWAVE, E.INCREASE_POWER_WITH_MORE_HP);
      });

      it('Non-standard damage: Hidden Power is seen as its own type', () => {
        // IVs whose Hidden Power is Ghost (bits 26: Attack, Speed and Special Attack odd), then Fighting (all even).
        b({ moves: [M.HIDDEN_POWER], effect: E.RANDOM_POWER_BASED_ON_IVS, ai: { ivs: { hp: 30, atk: 31, def: 30, spe: 31, spa: 31, spd: 30 } } }, '-10');
        b({ moves: [M.HIDDEN_POWER], ai: { ivs: { hp: 30, atk: 30, def: 30, spe: 30, spa: 30, spd: 30 } } }, '0');
      });

      it('Non-standard damage: Wonder Guard, no Mold Breaker, not super effective: -10', () => {
        // Razor Wind reaches script.s:582: on its charge turn ApplyTypeChart sets no MOVE_STATUS_WONDER_GUARD
        // (MoveIsOnDamagingTurn, battle_lib.c:7588), so the type check at :575 passes it.
        b({ moves: [M.RAZOR_WIND], player: { ability: A.WONDER_GUARD } }, '-10');
        b({ moves: [M.RAZOR_WIND], ai: { ability: A.MOLD_BREAKER }, player: { ability: A.WONDER_GUARD } }, '0');
        b({ moves: [M.SEISMIC_TOSS], player: { ability: A.WONDER_GUARD } }, '0'); // super effective on a Normal type
      });

      it('Moves that force switches: no Pokémon left to send in, or Suction Cups without Mold Breaker: -10', () => {
        const roar = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ROAR], effect: E.FORCE_SWITCH, ...s });
        b(roar(), '0');
        b(roar({ playerBench: 0 }), '-10');
        b(roar({ player: { ability: A.SUCTION_CUPS } }), '-10');
        b(roar({ player: { ability: A.SUCTION_CUPS }, ai: { ability: A.MOLD_BREAKER } }), '0');
        b({ moves: [M.WHIRLWIND], effect: E.FORCE_SWITCH, playerBench: 0 }, '-10');
      });

      it('Recovery moves: at 100% HP: -8', () => {
        for (const [move, effect] of [[M.RECOVER, E.RESTORE_HALF_HP], [M.MORNING_SUN, E.HEAL_HALF_MORE_IN_SUN], [M.ROOST, E.HEAL_HALF_REMOVE_FLYING_TYPE]] as const) {
          b({ moves: [move], effect }, '-8');
          b({ moves: [move], effect, ai: { hp: 199 } }, '0'); // 99%
        }
      });

      it('Reflect / Light Screen / Mist / Safeguard: already up: -8', () => {
        const screens = [
          [M.REFLECT, E.SET_REFLECT, SIDE_CONDITION_REFLECT], [M.LIGHT_SCREEN, E.SET_LIGHT_SCREEN, SIDE_CONDITION_LIGHT_SCREEN],
          [M.MIST, E.PREVENT_STAT_REDUCTION, SIDE_CONDITION_MIST], [M.SAFEGUARD, E.PREVENT_STATUS, SIDE_CONDITION_SAFEGUARD],
        ] as const;
        for (const [move, effect, side] of screens) {
          b({ moves: [move], effect, sides: [0, side] }, '-8');
          b({ moves: [move], effect, sides: [side, 0] }, '0'); // the target's side doesn't count
        }
      });

      it('OHKO moves: immune by type, Sturdy without Mold Breaker, a higher-level target: -10', () => {
        const ohko = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.GUILLOTINE], effect: E.ONE_HIT_KO, ...s });
        b(ohko(), '0');
        b(ohko({ player: { types: [TYPE_GHOST, TYPE_GHOST] } }), '-10');
        b(ohko({ player: { ability: A.STURDY } }), '-10');
        b(ohko({ player: { ability: A.STURDY }, ai: { ability: A.MOLD_BREAKER } }), '0');
        b(ohko({ player: { level: 51 } }), '-10');
        // Fissure and Horn Drill skip the damage scoring (script.s:57–58) but meet the same checks.
        b({ moves: [M.FISSURE], effect: E.ONE_HIT_KO, player: { types: [TYPE_NORMAL, TYPE_FLYING] } }, '-10');
        b({ moves: [M.HORN_DRILL], effect: E.ONE_HIT_KO, player: { level: 51 } }, '-10');
      });

      it('Focus Energy / Ingrain / Camouflage / Power Trick / Lucky Chant / Aqua Ring / Magnet Rise: already under it: -10', () => {
        b({ moves: [M.FOCUS_ENERGY], effect: E.CRIT_UP_2, ai: { statusVolatile: VOLATILE_CONDITION_FOCUS_ENERGY } }, '-10');
        b({ moves: [M.FOCUS_ENERGY] }, '0');
        b({ moves: [M.INGRAIN], effect: E.GROUND_TRAP_USER_CONTINUOUS_HEAL, ai: { moveEffectsMask: MOVE_EFFECT_INGRAIN } }, '-10');
        b({ moves: [M.CAMOUFLAGE], effect: E.CAMOUFLAGE, ai: { moveEffectsMask: MOVE_EFFECT_CAMOUFLAGE } }, '-10');
        b({ moves: [M.POWER_TRICK], effect: E.SWAP_ATK_DEF, ai: { moveEffectsMask: MOVE_EFFECT_POWER_TRICK } }, '-10');
        b({ moves: [M.LUCKY_CHANT], effect: E.PREVENT_CRITS, sides: [0, SIDE_CONDITION_LUCKY_CHANT_0] }, '-10');
        b({ moves: [M.AQUA_RING], effect: E.RESTORE_HP_EVERY_TURN, ai: { moveEffectsMask: MOVE_EFFECT_AQUA_RING } }, '-10');
        b({ moves: [M.MAGNET_RISE], effect: E.GIVE_GROUND_IMMUNITY, ai: { moveEffectsMask: MOVE_EFFECT_MAGNET_RISE } }, '-10');
        b({ moves: [M.MAGNET_RISE] }, '0');
        // Hack: no move has Mud Sport's or Water Sport's effect (the hack's 300 is HP Ground, 346 Scald).
        noHackMove(E.HALVE_ELECTRIC_DAMAGE, E.HALVE_FIRE_DAMAGE);
      });

      it('Magnet Rise: Levitate or a Flying type: -10', () => {
        b({ moves: [M.MAGNET_RISE], ai: { ability: A.LEVITATE } }, '-10');
        b({ moves: [M.MAGNET_RISE], ai: { types: [TYPE_STEEL, TYPE_FLYING] } }, '-10');
      });

      it('Substitute: already behind one -8; under 26% HP -10', () => {
        b({ moves: [M.SUBSTITUTE], effect: E.SET_SUBSTITUTE }, '0');
        b({ moves: [M.SUBSTITUTE], ai: { statusVolatile: VOLATILE_CONDITION_SUBSTITUTE } }, '-8');
        b({ moves: [M.SUBSTITUTE], ai: { hp: 51 } }, '-10'); // 25%
        b({ moves: [M.SUBSTITUTE], ai: { hp: 52 } }, '0'); // 26%
      });

      it('Leech Seed: seeded, a Grass type, Magic Guard: -10', () => {
        const seed = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.LEECH_SEED], effect: E.STATUS_LEECH_SEED, ...s });
        b(seed(), '0');
        b(seed({ player: { moveEffectsMask: MOVE_EFFECT_LEECH_SEED } }), '-10');
        b(seed({ player: { types: [TYPE_NORMAL, TYPE_GRASS] } }), '-10');
        b(seed({ player: { ability: A.MAGIC_GUARD } }), '-10');
      });

      it('Disable / Encore: the target is already under it: -8', () => {
        b({ moves: [M.DISABLE], effect: E.DISABLE }, '0');
        b({ moves: [M.DISABLE], player: { effects: { disabledTurns: 3 } } }, '-8');
        b({ moves: [M.ENCORE], effect: E.ENCORE, player: { effects: { encoredTurns: 3 } } }, '-8');
      });

      it('Snore / Sleep Talk: the attacker is awake: -8', () => {
        b({ moves: [M.SNORE], effect: E.DAMAGE_WHILE_ASLEEP }, '-8');
        b({ moves: [M.SNORE], ai: { status: ASLEEP } }, '0');
        b({ moves: [M.SLEEP_TALK], effect: E.USE_RANDOM_LEARNED_MOVE_SLEEP }, '-8');
        b({ moves: [M.SLEEP_TALK], ai: { status: ASLEEP } }, '0');
      });

      it('Lock On / Mean Look / Foresight / Perish Song / Torment / Miracle Eye / Gastro Acid: the target is already under it: -10', () => {
        b({ moves: [M.LOCK_ON], effect: E.NEXT_ATTACK_ALWAYS_HITS }, '0');
        b({ moves: [M.LOCK_ON], player: { moveEffectsMask: MOVE_EFFECT_LOCK_ON_0 } }, '-10');
        b({ moves: [M.MEAN_LOOK], effect: E.PREVENT_ESCAPE, player: { statusVolatile: VOLATILE_CONDITION_MEAN_LOOK } }, '-10');
        b({ moves: [M.FORESIGHT], effect: E.FORESIGHT, player: { statusVolatile: VOLATILE_CONDITION_FORESIGHT } }, '-10');
        b({ moves: [M.PERISH_SONG], effect: E.ALL_FAINT_3_TURNS, player: { moveEffectsMask: MOVE_EFFECT_PERISH_SONG } }, '-10');
        b({ moves: [M.TORMENT], effect: E.TORMENT, player: { statusVolatile: VOLATILE_CONDITION_TORMENT } }, '-10');
        b({ moves: [M.MIRACLE_EYE], effect: E.IGNORE_EVATION_REMOVE_DARK_IMMUNE, player: { moveEffectsMask: MOVE_EFFECT_MIRACLE_EYE } }, '-10');
        b({ moves: [M.GASTRO_ACID], effect: E.SUPRESS_ABILITY, player: { moveEffectsMask: MOVE_EFFECT_ABILITY_SUPPRESSED } }, '-10');
        b({ moves: [M.GASTRO_ACID] }, '0');
        noHackMove(E.PREVENT_HEALING); // Hack: the hack's 377 is Aqua Cutter, so no move has Heal Block's effect
      });

      it('Lock On: No Guard on either side: -10', () => {
        b({ moves: [M.LOCK_ON], ai: { ability: A.NO_GUARD } }, '-10');
        b({ moves: [M.MIND_READER], effect: E.NEXT_ATTACK_ALWAYS_HITS, player: { ability: A.NO_GUARD } }, '-10');
      });

      it('Gastro Acid: Multitype, Truant, Slow Start, Stench, Run Away, Pickup or Honey Gather: -10', () => {
        for (const ability of [A.MULTITYPE, A.TRUANT, A.SLOW_START, A.STENCH, A.RUN_AWAY, A.PICKUP, A.HONEY_GATHER]) {
          b({ moves: [M.GASTRO_ACID], player: { ability } }, '-10');
        }
      });

      it('Curse: a Ghost into a cursed or Magic Guard target -10; Simple at +2 -10; Attack or Defense at +6 -10', () => {
        const curse = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.CURSE], effect: E.CURSE, ...s });
        const ghost: [number, number] = [TYPE_GHOST, TYPE_GHOST];
        b(curse({ ai: { types: ghost } }), '0');
        b(curse({ ai: { types: ghost }, player: { statusVolatile: VOLATILE_CONDITION_CURSE } }), '-10');
        b(curse({ ai: { types: ghost }, player: { ability: A.MAGIC_GUARD } }), '-10');
        // Gist error: Simple's test is IfStatStageGreaterThan 8, so +3 (script.s:690–691); +2 passes.
        b(curse({ ai: { ability: A.SIMPLE, stages: { attack: 3 } } }), '-10');
        b(curse({ ai: { ability: A.SIMPLE, stages: { defense: 3 } } }), '-10');
        b(curse({ ai: { ability: A.SIMPLE, stages: { attack: 2 } } }), '0');
        b(curse({ ai: { stages: { attack: 6 } } }), '-10');
        // Gist error: +6 Defense gives -8 (ScoreMinus8, script.s:697).
        b(curse({ ai: { stages: { defense: 6 } } }), '-8');
      });

      it('Spikes / Toxic Spikes / Stealth Rock: the maximum layers already, or the target on its last Pokémon: -10', () => {
        b({ moves: [M.SPIKES], effect: E.SET_SPIKES, playerHazards: { spikes: 2 } }, '0');
        b({ moves: [M.SPIKES], playerHazards: { spikes: 3 } }, '-10');
        b({ moves: [M.SPIKES], playerBench: 0 }, '-10');
        b({ moves: [M.TOXIC_SPIKES], effect: E.TOXIC_SPIKES, playerHazards: { toxicSpikes: 1 } }, '0');
        b({ moves: [M.TOXIC_SPIKES], playerHazards: { toxicSpikes: 2 } }, '-10');
        b({ moves: [M.TOXIC_SPIKES], playerBench: 0 }, '-10');
        b({ moves: [M.STEALTH_ROCK], effect: E.STEALTH_ROCK }, '0');
        b({ moves: [M.STEALTH_ROCK], sides: [SIDE_CONDITION_STEALTH_ROCK, 0] }, '-10');
        b({ moves: [M.STEALTH_ROCK], playerBench: 0 }, '-10');
      });

      it('Weather moves: the weather is already up: -8', () => {
        b({ moves: [M.SANDSTORM], effect: E.WEATHER_SANDSTORM }, '0');
        b({ moves: [M.SANDSTORM], field: FIELD_CONDITION_SANDSTORM_PERM }, '-8');
        b({ moves: [M.RAIN_DANCE], effect: E.WEATHER_RAIN, field: FIELD_CONDITION_RAINING_PERM }, '-8');
        b({ moves: [M.SUNNY_DAY], effect: E.WEATHER_SUN, field: FIELD_CONDITION_SUNNY_PERM }, '-8');
        b({ moves: [M.HAIL], effect: E.WEATHER_HAIL, field: FIELD_CONDITION_HAILING_PERM }, '-8');
        b({ moves: [M.HAIL], field: FIELD_CONDITION_SUNNY_PERM }, '0');
      });

      it('Rain Dance: neither Swift Swim nor Hydration, into a statused Hydration target: -8', () => {
        const hydration = { ability: A.HYDRATION, status: MON_CONDITION_BURN };
        b({ moves: [M.RAIN_DANCE], player: hydration }, '-8');
        b({ moves: [M.RAIN_DANCE], player: { ability: A.HYDRATION } }, '0');
        b({ moves: [M.RAIN_DANCE], ai: { ability: A.SWIFT_SWIM }, player: hydration }, '0');
        b({ moves: [M.RAIN_DANCE], ai: { ability: A.HYDRATION }, player: hydration }, '0');
      });

      it('Sunny Day: none of Flower Gift, Leaf Guard, Solar Power, into a statused Hydration target: -10', () => {
        const hydration = { ability: A.HYDRATION, status: MON_CONDITION_BURN };
        b({ moves: [M.SUNNY_DAY], player: hydration }, '-10');
        for (const ability of [A.FLOWER_GIFT, A.LEAF_GUARD, A.SOLAR_POWER]) b({ moves: [M.SUNNY_DAY], ai: { ability }, player: hydration }, '0');
      });

      it('Hail: into Ice Body -8, undone by our own Ice Body', () => {
        b({ moves: [M.HAIL], player: { ability: A.ICE_BODY } }, '-8');
        b({ moves: [M.HAIL], ai: { ability: A.ICE_BODY }, player: { ability: A.ICE_BODY } }, '0');
        b({ moves: [M.HAIL], ai: { ability: A.ICE_BODY } }, '0');
      });

      it('Future Sight / Doom Desire: a Future Sight pending on either side: -12', () => {
        b({ moves: [M.FUTURE_SIGHT], effect: E.HIT_IN_3_TURNS }, '0');
        b({ moves: [M.FUTURE_SIGHT], sides: [SIDE_CONDITION_FUTURE_SIGHT, 0] }, '-12');
        b({ moves: [M.FUTURE_SIGHT], sides: [0, SIDE_CONDITION_FUTURE_SIGHT] }, '-12');
      });

      it('Baton Pass: on its last Pokémon: -10', () => {
        b({ moves: [M.BATON_PASS], effect: E.PASS_STATS_AND_STATUS }, '0');
        b({ moves: [M.BATON_PASS], aiBench: 0 }, '-10');
        b({ moves: [M.BATON_PASS], aiBench: [{ hp: 0 }] }, '-10'); // a fainted member doesn't count
      });

      it("Fake Out: not the attacker's first turn: -10", () => {
        b({ moves: [M.FAKE_OUT], effect: E.ALWAYS_FLINCH_FIRST_TURN_ONLY }, '0');
        // LoadIsFirstTurnInBattle is FALSE once fakeOutTurnNumber < totalTurns (trainer_ai.c:2487–2491).
        b({ moves: [M.FAKE_OUT], turn: 1 }, '-10');
        b({ moves: [M.FAKE_OUT], turn: 1, ai: { effects: { fakeOutTurnNumber: 1 } } }, '0'); // switched in last turn
      });

      it('Stockpile: at 3 already: -10 (hack: Stockpile has Cosmic Power\'s effect)', () => {
        // Hack: no move has STOCKPILE; the hack's Stockpile raises Defense and Special Defense (DEF_SPD_UP), so it
        // takes Basic_CheckCosmicPower (script.s:247): the count doesn't matter, +6 Defense does.
        noHackMove(E.STOCKPILE);
        b({ moves: [M.STOCKPILE], effect: E.DEF_SPD_UP, ai: { effects: { stockpileCount: 3 } } }, '0');
        b({ moves: [M.STOCKPILE], ai: { stages: { defense: 6 } } }, '-10');
      });

      it('Spit Up / Swallow: immune by type or nothing stockpiled: -10 (hack: no move has either effect)', () => {
        // Hack: the hack's 255 is HP Rock, a plain hit, and its Swallow (256) has Whirlpool's binding effect.
        noHackMove(E.SPIT_UP, E.SWALLOW);
        b({ moves: [M.SPIT_UP], effect: E.HIT, ai: { effects: { stockpileCount: 0 } } }, '0');
        b({ moves: [M.SWALLOW], effect: E.WHIRLPOOL, ai: { effects: { stockpileCount: 0 } } }, '0');
      });

      it("Memento: Clear Body or White Smoke -10, Attack at -6 -10, Special Attack at -6 -8, last Pokémon -10 (hack: Explosion's checks)", () => {
        // Hack: no move has Memento's effect; the hack's Memento has Explosion's HALVE_DEFENSE, so it takes
        // Basic_CheckCannotExplode (script.s:135): no stat or ability checks, and -1 when both sides are on their last.
        noHackMove(E.FAINT_AND_ATK_SP_ATK_DOWN_2);
        const memento = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.MEMENTO], effect: E.HALVE_DEFENSE, ...s });
        b(memento({ player: { ability: A.CLEAR_BODY } }), '0');
        b(memento({ player: { stages: { attack: -6 } } }), '0');
        b(memento({ player: { stages: { spAttack: -6 } } }), '0');
        b(memento({ aiBench: 0 }), '-10');
        b(memento({ aiBench: 0, playerBench: 0 }), '-1');
        b(memento({ player: { ability: A.DAMP } }), '-10');
      });

      it('Helping Hand: not a double battle: -10', () => {
        b({ moves: [M.HELPING_HAND], effect: E.BOOST_ALLY_POWER_BY_50_PERCENT }, '-10');
      });

      it('Trick / Switcheroo / Knock Off: Sticky Hold or no item: -10 (no Mold Breaker check)', () => {
        const knock = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.KNOCK_OFF], effect: E.REMOVE_HELD_ITEM, ...s });
        b(knock({ player: { item: I.LEFTOVERS } }), '0');
        b(knock(), '-10');
        b(knock({ player: { item: I.LEFTOVERS, ability: A.STICKY_HOLD } }), '-10');
        b(knock({ player: { item: I.LEFTOVERS, ability: A.STICKY_HOLD }, ai: { ability: A.MOLD_BREAKER } }), '-10');
        // Hack: no move has SWITCH_HELD_ITEMS; the hack's 271 and 415 are HP Psychic and HP Flying, plain hits.
        noHackMove(E.SWITCH_HELD_ITEMS);
        b({ moves: [M.TRICK], effect: E.HIT }, '0');
      });

      it('Imprison: either side already under it: -10', () => {
        b({ moves: [M.IMPRISON], effect: E.MAKE_SHARED_MOVES_UNUSEABLE }, '0');
        b({ moves: [M.IMPRISON], ai: { moveEffectsMask: MOVE_EFFECT_IMPRISON } }, '-10');
        b({ moves: [M.IMPRISON], player: { moveEffectsMask: MOVE_EFFECT_IMPRISONED } }, '-10');
      });

      it('Refresh: no burn, poison or paralysis: -10', () => {
        b({ moves: [M.REFRESH], effect: E.HEAL_STATUS }, '-10');
        for (const status of [MON_CONDITION_BURN, MON_CONDITION_POISON, MON_CONDITION_TOXIC, MON_CONDITION_PARALYSIS]) {
          b({ moves: [M.REFRESH], ai: { status } }, '0');
        }
        b({ moves: [M.REFRESH], ai: { status: ASLEEP } }, '-10');
      });

      it('Tickle: Clear Body or White Smoke without Mold Breaker -10; Attack at -6 -10; Defense at -6 -8', () => {
        const tickle = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.TICKLE], effect: E.ATK_DEF_DOWN, ...s });
        b(tickle(), '0');
        b(tickle({ player: { ability: A.CLEAR_BODY } }), '-10');
        b(tickle({ player: { ability: A.WHITE_SMOKE } }), '-10');
        b(tickle({ player: { ability: A.CLEAR_BODY }, ai: { ability: A.MOLD_BREAKER } }), '0');
        b(tickle({ player: { stages: { attack: -6 } } }), '-10');
        b(tickle({ player: { stages: { defense: -6 } } }), '-8');
      });

      it('Cosmic Power / Bulk Up / Calm Mind / Dragon Dance: Simple at +3 -10; first stat at +6 -10; second -8; Dragon Dance under Trick Room -10', () => {
        const pairs: [number, number, StageName, StageName][] = [
          [M.COSMIC_POWER, E.DEF_SPD_UP, 'defense', 'spDefense'], [M.BULK_UP, E.ATK_DEF_UP, 'attack', 'defense'],
          [M.CALM_MIND, E.SP_ATK_SP_DEF_UP, 'spAttack', 'spDefense'], [M.DRAGON_DANCE, E.ATK_SPD_UP, 'attack', 'speed'],
        ];
        for (const [move, effect, first, second] of pairs) {
          b({ moves: [move], effect }, '0');
          b({ moves: [move], ai: { ability: A.SIMPLE, stages: { [first]: 3 } } }, '-10');
          b({ moves: [move], ai: { ability: A.SIMPLE, stages: { [second]: 3 } } }, '-10');
          b({ moves: [move], ai: { ability: A.SIMPLE, stages: { [second]: 2 } } }, '0');
          b({ moves: [move], ai: { stages: { [first]: 6 } } }, '-10');
          b({ moves: [move], ai: { stages: { [second]: 6 } } }, '-8');
        }
        b({ moves: [M.DRAGON_DANCE], field: FIELD_CONDITION_TRICK_ROOM_INIT }, '-10');
        b({ moves: [M.BULK_UP], field: FIELD_CONDITION_TRICK_ROOM_INIT }, '0');
      });

      it('Gravity / Tailwind: already up -10; Tailwind under Trick Room -10', () => {
        b({ moves: [M.GRAVITY], effect: E.GRAVITY }, '0');
        b({ moves: [M.GRAVITY], field: FIELD_CONDITION_GRAVITY_INIT }, '-10');
        b({ moves: [M.TAILWIND], effect: E.DOUBLE_SPEED_3_TURNS }, '0');
        b({ moves: [M.TAILWIND], sides: [0, SIDE_CONDITION_TAILWIND_0] }, '-10');
        b({ moves: [M.TAILWIND], field: FIELD_CONDITION_TRICK_ROOM_INIT }, '-10');
      });

      it('Trick Room: faster than or tied with the target: -10', () => {
        b({ moves: [M.TRICK_ROOM], effect: E.TRICK_ROOM }, '0'); // the AI is slower
        b({ moves: [M.TRICK_ROOM], ai: { speed: 130 } }, '-10');
        // An exact tie draws a coin in each of the two comparisons, COMPARE_SPEED_TIE or _FASTER (battle_lib.c:1440–1448):
        // -10 unless the first says TIE and the second FASTER (script.s:1504–1505).
        b({ moves: [M.TRICK_ROOM], ai: { speed: 110 } }, '3/4: -10, 1/4: 0');
      });

      it('Healing Wish / Lunar Dance: -20, -10 more on the last Pokémon, -10 more with no one to heal (hack: no move has either effect)', () => {
        // Hack: no move has either effect. The hack's Lunar Dance restores half its HP (RESTORE_HALF_HP), so it is
        // scored as a recovery move; its 361 is HP Electric, a plain hit.
        noHackMove(E.FAINT_AND_FULL_HEAL_NEXT_MON, E.FAINT_FULL_RESTORE_NEXT_MON);
        b({ moves: [M.LUNAR_DANCE], effect: E.RESTORE_HALF_HP }, '-8');
        b({ moves: [M.LUNAR_DANCE], aiBench: 0, ai: { hp: 100 } }, '0');
        b({ moves: [M.HEALING_WISH], effect: E.HIT, aiBench: 0 }, '0');
      });

      it('Natural Gift: no berry, or a berry whose type the target is immune to: -10', () => {
        b({ moves: [M.NATURAL_GIFT], effect: E.NATURAL_GIFT }, '-10');
        b({ moves: [M.NATURAL_GIFT], ai: { item: I.LEFTOVERS } }, '-10');
        b({ moves: [M.NATURAL_GIFT], ai: { item: I.CHERI_BERRY } }, '0');
        b({ moves: [M.NATURAL_GIFT], ai: { item: I.WACAN_BERRY }, player: { types: [TYPE_GROUND, TYPE_GROUND] } }, '-10'); // an Electric gift
      });

      it('Acupressure: any stat at +6 (+3 with Simple): -10', () => {
        b({ moves: [M.ACUPRESSURE], effect: E.RANDOM_STAT_UP_2 }, '0');
        for (const stat of ['attack', 'defense', 'speed', 'spAttack', 'spDefense', 'accuracy', 'evasion'] as const) {
          b({ moves: [M.ACUPRESSURE], ai: { stages: { [stat]: 6 } } }, '-10');
          b({ moves: [M.ACUPRESSURE], ai: { ability: A.SIMPLE, stages: { [stat]: 3 } } }, '-10');
        }
        b({ moves: [M.ACUPRESSURE], ai: { ability: A.SIMPLE, stages: { speed: 2 } } }, '0');
      });

      it('Metal Burst: target Stall or Shiny Stone -10; our own Stall or Shiny Stone +10; faster than the target -10', () => {
        const burst = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.METAL_BURST], effect: E.METAL_BURST, ...s });
        b(burst(), '0'); // the AI is slower
        b(burst({ player: { ability: A.STALL } }), '-10');
        b(burst({ player: { item: I.SHINY_STONE } }), '-10');
        b(burst({ ai: { speed: 130 } }), '-10');
        // Gist error: our own Stall or Shiny Stone skips the speed check and ends (Basic_CheckMetalBurst_Terminate,
        // script.s:1175–1176): no +10.
        b(burst({ ai: { speed: 130, ability: A.STALL } }), '0');
        b(burst({ ai: { speed: 130, item: I.SHINY_STONE } }), '0');
        // Hack: Bide has Metal Burst's effect, so it takes this routine.
        b({ moves: [M.BIDE], effect: E.METAL_BURST, ai: { speed: 130 } }, '-10');
      });

      it('Embargo: already under it -10; with a recyclable item, in the Frontier -10', () => {
        const embargo = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.EMBARGO], effect: E.PREVENT_ITEM_USE, ...s });
        b(embargo(), '0');
        b(embargo({ player: { moveEffectsMask: MOVE_EFFECT_EMBARGO } }), '-10');
        b(embargo({ recycleItem: [I.LEFTOVERS, 0, 0, 0], battleType: BATTLE_TYPE_FRONTIER_SINGLES }), '-10');
        b(embargo({ battleType: BATTLE_TYPE_FRONTIER_SINGLES }), '0');
        b(embargo({ recycleItem: [I.LEFTOVERS, 0, 0, 0] }), '0');
      });

      it('Fling: no power -10; Multitype -10; a status the target is immune to -5', () => {
        const fling = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.FLING], effect: E.FLING, ...s });
        b(fling(), '-10'); // no item: Fling power 0 (IfLoadedLessThan 10, script.s:1205)
        b(fling({ ai: { item: I.LEFTOVERS } }), '0');
        b(fling({ ai: { item: I.LEFTOVERS, ability: A.MULTITYPE } }), '-10');
        // Gist error: a status the target is immune to gives -5 only if the attacker can't take it either; if it
        // can, +3 (script.s:1235–1251, 1265–1278).
        b(fling({ ai: { item: I.TOXIC_ORB }, player: { types: [TYPE_POISON, TYPE_POISON] } }), '+3');
        b(fling({ ai: { item: I.TOXIC_ORB, types: [TYPE_STEEL, TYPE_STEEL] }, player: { types: [TYPE_POISON, TYPE_POISON] } }), '-5');
        b(fling({ ai: { item: I.TOXIC_ORB } }), '0'); // the target can be poisoned
        b(fling({ ai: { item: I.FLAME_ORB }, player: { types: [TYPE_FIRE, TYPE_FIRE] } }), '+3');
        b(fling({ ai: { item: I.FLAME_ORB, types: [TYPE_FIRE, TYPE_FIRE] }, player: { types: [TYPE_FIRE, TYPE_FIRE] } }), '-5');
        // Light Ball (paralysis) checks only the target (script.s:1280–1286).
        b(fling({ ai: { item: I.LIGHT_BALL }, player: { ability: A.LIMBER } }), '-5');
        b(fling({ ai: { item: I.LIGHT_BALL }, player: { status: MON_CONDITION_BURN } }), '-5');
        b(fling({ ai: { item: I.LIGHT_BALL } }), '0');
      });

      it('Psycho Shift: no status of ours, a statused or Safeguarded target, or a status the target is immune to: -10', () => {
        const shift = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.PSYCHO_SHIFT], effect: E.TRANSFER_STATUS, ...s });
        const psn = { status: MON_CONDITION_POISON };
        const brn = { status: MON_CONDITION_BURN };
        const par = { status: MON_CONDITION_PARALYSIS };
        b(shift(), '-10');
        b(shift({ ai: psn }), '0');
        b(shift({ ai: psn, player: { status: MON_CONDITION_BURN } }), '-10');
        b(shift({ ai: psn, sides: safeguard }), '-10');
        b(shift({ ai: { ...psn, ability: A.POISON_HEAL } }), '-10');
        b(shift({ ai: psn, player: { types: [TYPE_STEEL, TYPE_STEEL] } }), '-10');
        b(shift({ ai: psn, player: { ability: A.IMMUNITY } }), '-10');
        b(shift({ ai: brn }), '0');
        b(shift({ ai: brn, player: { types: [TYPE_FIRE, TYPE_FIRE] } }), '-10');
        b(shift({ ai: brn, player: { ability: A.WATER_VEIL } }), '-10');
        b(shift({ ai: par }), '0');
        b(shift({ ai: par, player: { ability: A.LIMBER } }), '-10');
        b(shift({ ai: par, player: { ability: A.MAGIC_GUARD } }), '0'); // Magic Guard isn't checked for paralysis
      });

      it("Copycat: the battle's first turn and faster than the target: -10", () => {
        b({ moves: [M.COPYCAT], effect: E.USE_LAST_USED_MOVE }, '0');
        b({ moves: [M.COPYCAT], ai: { speed: 130 } }, '-10');
        b({ moves: [M.COPYCAT], ai: { speed: 130 }, turn: 1 }, '0');
      });

      it('Power Swap / Guard Swap: a net-negative change to both stats: -10', () => {
        // DiffStatStages is the target's stage less ours, and the routine wants it at 1 or more for one of the two
        // stats (script.s:1395–1401): an even swap, gaining nothing, is -10 too.
        b({ moves: [M.POWER_SWAP], effect: E.SWAP_ATK_SP_ATK_STAT_CHANGES }, '-10');
        b({ moves: [M.POWER_SWAP], player: { stages: { attack: 1 } } }, '0');
        b({ moves: [M.POWER_SWAP], player: { stages: { spAttack: 1 } } }, '0');
        b({ moves: [M.POWER_SWAP], ai: { stages: { attack: -1 } } }, '0');
        b({ moves: [M.POWER_SWAP], ai: { stages: { attack: 2 } }, player: { stages: { attack: 1 } } }, '-10');
        b({ moves: [M.GUARD_SWAP], effect: E.SWAP_DEF_SP_DEF_STAT_CHANGES }, '-10');
        b({ moves: [M.GUARD_SWAP], player: { stages: { defense: 1 } } }, '0');
        b({ moves: [M.GUARD_SWAP], player: { stages: { spDefense: 1 } } }, '0');
      });

      it('Last Resort: the other moves not all used yet: -10', () => {
        b({ moves: [M.LAST_RESORT, M.TACKLE], effect: E.FAIL_IF_NOT_USED_ALL_OTHER_MOVES }, '-10');
        b({ moves: [M.LAST_RESORT, M.TACKLE], ai: { effects: { lastResortCount: 1 } } }, '0');
        b({ moves: [M.LAST_RESORT] }, '-10'); // alone, it can never be used (numKnownMoves > 1, trainer_ai.c:2039)
      });

      it('Worry Seed: Truant, Insomnia, Vital Spirit or Multitype -10; asleep without Sleep Talk or Snore -10', () => {
        const seed = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.WORRY_SEED], effect: E.SET_ABILITY_TO_INSOMNIA, ...s });
        b(seed(), '0');
        for (const ability of [A.TRUANT, A.INSOMNIA, A.VITAL_SPIRIT, A.MULTITYPE]) b(seed({ player: { ability } }), '-10');
        b(seed({ player: { status: ASLEEP } }), '-10');
        // Sleep Talk and Snore count when the AI has seen them (IfMoveKnown reads battlerMoves).
        b(seed({ player: { status: ASLEEP }, known: { moves: [M.SLEEP_TALK] } }), '0');
        b(seed({ player: { status: ASLEEP }, known: { moves: [M.SNORE] } }), '0');
        b(seed({ player: { status: ASLEEP, moves: [M.SLEEP_TALK] } }), '-10'); // known, not merely held
      });

      it('Defog: only at -6 evasion with no screens or fog; then the last Pokémon -10, or no hazards -10', () => {
        const defog = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.DEFOG], effect: E.REMOVE_HAZARDS_SCREENS_EVA_DOWN, ...s });
        const low = { stages: { evasion: -6 } };
        b(defog(), '0');
        b(defog({ playerBench: 0 }), '0');
        b(defog({ player: low }), '-10');
        for (const hazard of [SIDE_CONDITION_SPIKES, SIDE_CONDITION_STEALTH_ROCK, SIDE_CONDITION_TOXIC_SPIKES]) {
          b(defog({ player: low, sides: [hazard, 0] }), '0');
        }
        b(defog({ player: low, sides: [SIDE_CONDITION_REFLECT, 0] }), '0');
        b(defog({ player: low, sides: [SIDE_CONDITION_LIGHT_SCREEN, 0] }), '0');
        b(defog({ player: low, field: FIELD_CONDITION_DEEP_FOG }), '0');
        b(defog({ player: low, sides: [SIDE_CONDITION_SPIKES, 0], playerBench: 0 }), '-10');
      });

      it('Captivate: Oblivious, Clear Body or White Smoke without Mold Breaker; the same gender; no gender; Special Attack at -6: -10', () => {
        const cap = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.CAPTIVATE], effect: E.SP_ATK_DOWN_2_OPPOSITE_GENDER, ...s });
        b(cap(), '0');
        for (const ability of [A.OBLIVIOUS, A.CLEAR_BODY, A.WHITE_SMOKE]) b(cap({ player: { ability } }), '-10');
        b(cap({ player: { ability: A.OBLIVIOUS }, ai: { ability: A.MOLD_BREAKER } }), '0');
        b(cap({ player: { gender: GENDER_MALE } }), '-10');
        b(cap({ player: { gender: GENDER_NONE } }), '-10');
        b(cap({ ai: { gender: GENDER_NONE } }), '-10');
        b(cap({ player: { stages: { spAttack: -6 } } }), '-10');
      });
    });
  });

  describe('Evaluate Attack', () => {
    const ev = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_EVAL_ATTACK, setup, expected);
    const nearlyFainted = { hp: 1 };

    it('1.1 a kill with Self-Destruct: no additional scoring', () => {
      // Gist error: Explosion is never damage-scored (sNoDamageCalcMoveEffects, trainer_ai.c:31–46), so
      // IfCurrentMoveKills never jumps (trainer_ai.c:1553–1554) and script.s:6389 is never reached; rule 3 scores it.
      ev({ moves: [M.EXPLOSION], player: nearlyFainted }, MINUS_2_DEPRIORITIZE);
      ev({ moves: [M.SELF_DESTRUCT], player: nearlyFainted }, MINUS_2_DEPRIORITIZE);
    });

    it('1.2 a kill with Focus Punch, Sucker Punch or Future Sight: 86/256 +4', () => {
      ev({ moves: [M.FUTURE_SIGHT], effect: E.HIT_IN_3_TURNS, player: nearlyFainted }, '86/256: +4, 170/256: 0'); // IfRandomLessThan 170
      // Focus Punch is never damage-scored either, so it never "kills" (the script's note at script.s:6392–6393).
      ev({ moves: [M.FOCUS_PUNCH], player: nearlyFainted }, MINUS_2_DEPRIORITIZE);
      // Hack: no move has Sucker Punch's effect; the hack's Sucker Punch is a plain priority hit, so a kill is +4.
      noHackMove(E.HIT_FIRST_IF_TARGET_ATTACKING);
      ev({ moves: [M.SUCKER_PUNCH], effect: E.HIT, player: nearlyFainted }, '+4');
    });

    it('1.3 a kill with the Priority +1 effect: +6', () => {
      ev({ moves: [M.QUICK_ATTACK], effect: E.PRIORITY_1, player: nearlyFainted }, '+6');
      ev({ moves: [M.FAKE_OUT], player: nearlyFainted }, '+4'); // +3 priority, but not the effect
    });

    it('1.4 any other kill: +4', () => {
      ev({ moves: [M.TACKLE], player: nearlyFainted }, '+4');
    });

    it('2. not the highest damage of our moves: -1', () => {
      ev({ moves: [M.TACKLE, M.MEGA_KICK] }, '-1');
      ev({ moves: [M.TACKLE, M.MEGA_KICK], slot: 1 }, '0');
      ev({ moves: [M.TACKLE] }, '0');
    });

    it('3. Self-Destruct, Focus Punch or Sucker Punch: ~80% -2', () => {
      ev({ moves: [M.EXPLOSION] }, MINUS_2_DEPRIORITIZE);
      ev({ moves: [M.FOCUS_PUNCH], effect: E.HIT_LAST_WHIFF_IF_HIT }, MINUS_2_DEPRIORITIZE);
    });

    it('4. quad effective: 31.25% +2', () => {
      // Gist error: IfRandomLessThan 80 skips the +2 (script.s:6383), so +2 has 176/256 (68.75%).
      ev({ moves: [M.BRICK_BREAK], player: { types: [TYPE_NORMAL, TYPE_ICE], maxHP: 300 } }, PLUS_2_OFTEN);
      ev({ moves: [M.BRICK_BREAK], player: { maxHP: 300 } }, '0'); // super effective only
    });
  });

  describe('Setup First Turn', () => {
    const sf = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_SETUP_FIRST_TURN, setup, expected);

    it('on the battle\'s first turn, a setup effect: 68.75% +2', () => {
      const setupMoves = [
        M.HOWL, M.HARDEN, M.GROWTH, M.DOUBLE_TEAM, M.GROWL, M.LEER, M.STRING_SHOT, M.SAND_ATTACK, M.SWEET_SCENT,
        M.LIGHT_SCREEN, M.AMNESIA, M.FOCUS_ENERGY, M.CONFUSE_RAY, M.SWORDS_DANCE, M.BARRIER, M.AGILITY, M.NASTY_PLOT,
        M.CHARM, M.SCREECH, M.SCARY_FACE, M.KINESIS, M.REFLECT, M.POISON_POWDER, M.THUNDER_WAVE, M.SUBSTITUTE,
        M.LEECH_SEED, M.MINIMIZE, M.CURSE, M.SWAGGER, M.CAMOUFLAGE, M.TORMENT, M.FLATTER, M.WILL_O_WISP, M.INGRAIN,
        M.IMPRISON, M.TICKLE, M.COSMIC_POWER, M.BULK_UP, M.CALM_MIND, M.TAILWIND, M.ACUPRESSURE, M.LUCKY_CHANT,
        M.MAGNET_RISE, M.DEFOG, M.WHIRLPOOL,
      ];
      for (const move of setupMoves) sf({ moves: [move] }, PLUS_2_OFTEN);
      sf({ moves: [M.SWORDS_DANCE], turn: 1 }, '0');
      sf({ moves: [M.TACKLE] }, '0');
    });

    it('note: sleep, Toxic and Dragon Dance are not setup effects', () => {
      // Gist error: "Condition-inducing Status moves (Poison, Sleep, ...)" and "Boosting Status moves": the table
      // (script.s:6435–6497) has neither STATUS_SLEEP nor STATUS_BADLY_POISON nor ATK_SPD_UP.
      sf({ moves: [M.HYPNOSIS] }, '0');
      sf({ moves: [M.TOXIC] }, '0');
      sf({ moves: [M.DRAGON_DANCE] }, '0');
      // Hack: no move has Conversion's effect (the hack's 160 is HP Ice) or Yawn's (its Yawn puts to sleep outright).
      noHackMove(E.CONVERSION, E.STATUS_SLEEP_NEXT_TURN);
      sf({ moves: [M.CONVERSION] }, '0');
    });
  });

  describe('Risky', () => {
    const r = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_RISKY, setup, expected);

    it('a Risky move: 50% +2', () => {
      const risky = [
        M.HYPNOSIS, M.EXPLOSION, M.MIRROR_MOVE, M.GUILLOTINE, M.SLASH, M.CONFUSE_RAY, M.METRONOME, M.PSYWAVE, M.COUNTER,
        M.MIRROR_COAT, M.METAL_BURST, M.DESTINY_BOND, M.SWAGGER, M.ATTRACT, M.PRESENT, M.ANCIENT_POWER, M.BELLY_DRUM,
        M.FOCUS_PUNCH, M.GYRO_BALL, M.ACUPRESSURE, M.PAYBACK, M.REVENGE, M.ME_FIRST,
      ];
      for (const move of risky) r({ moves: [move] }, PLUS_2_HALF);
      r({ moves: [M.TACKLE] }, '0');
    });

    it('Hack: Triple Axel and Fury Cutter (effect 88) are Risky; Memento and Bide too; Triple Kick, Rock Wrecker, Sucker Punch are not', () => {
      // Hack: docs/ai-changes.md, "Triple Axel and Fury Cutter count as Risky" (Risky_RiskyEffects, script.s:6544).
      r({ moves: [M.FURY_CUTTER], effect: E.RANDOM_DAMAGE_1_TO_150_LEVEL }, PLUS_2_HALF);
      r({ moves: [M.PSYWAVE], effect: E.RANDOM_DAMAGE_1_TO_150_LEVEL }, PLUS_2_HALF);
      r({ moves: [M.TRIPLE_KICK], effect: E.HIT_THREE_TIMES }, '0');
      r({ moves: [M.ROCK_WRECKER], effect: E.HIT_THREE_TIMES }, '0');
      // Hack: Memento has Explosion's effect and Bide has Metal Burst's, both in the table.
      r({ moves: [M.MEMENTO], effect: E.HALVE_DEFENSE }, PLUS_2_HALF);
      r({ moves: [M.BIDE], effect: E.METAL_BURST }, PLUS_2_HALF);
      // Hack: the hack's Sucker Punch is a plain hit; no move has its vanilla effect, nor the table's
      // DOUBLE_POWER_IF_HIT or CONFUSE_ALL.
      r({ moves: [M.SUCKER_PUNCH], effect: E.HIT }, '0');
      noHackMove(E.HIT_FIRST_IF_TARGET_ATTACKING, E.DOUBLE_POWER_IF_HIT, E.CONFUSE_ALL);
    });
  });

  describe('Prioritize Extremes', () => {
    const px = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_PRIORITIZE_EXTREMES, setup, expected);

    it('a move the damage calculation never scores: ~61% +2', () => {
      px({ moves: [M.HOWL] }, PLUS_2_EXTREMES); // power 0
      for (const move of [M.EXPLOSION, M.DREAM_EATER, M.RAZOR_WIND, M.WATER_SPOUT, M.HEAD_SMASH, M.FOCUS_PUNCH]) {
        px({ moves: [move] }, PLUS_2_EXTREMES); // sNoDamageCalcMoveEffects (trainer_ai.c:31–46)
      }
      for (const move of [M.FLAIL, M.COUNTER, M.MIRROR_COAT, M.SUPER_FANG, M.PRESENT, M.TRUMP_CARD]) {
        px({ moves: [move] }, PLUS_2_EXTREMES); // power 1 and not in sAltPowerMoveEffects
      }
      px({ moves: [M.TACKLE] }, '0');
    });

    it("note: the preface's list includes moves that are damage-scored", () => {
      // Gist error: the preface lists sAltPowerMoveEffects with sNoDamageCalcMoveEffects, but FlagMoveDamageScore
      // always estimates an alt-power effect (trainer_ai.c:1035), so these get nothing.
      for (const move of [M.SEISMIC_TOSS, M.NIGHT_SHADE, M.DRAGON_RAGE, M.HIDDEN_POWER, M.NATURAL_GIFT, M.GYRO_BALL, M.PSYWAVE]) {
        px({ moves: [move] }, '0');
      }
    });

    it('Hack: the effect-48 (RECOIL_QUARTER) moves are damage-scored; Take Down, Close Combat and Brave Bird are not', () => {
      // Hack: docs/ai-changes.md, whose Moves tab lists the effect-48 moves as 1/2 recoil. Effect 48 isn't in
      // sNoDamageCalcMoveEffects (vanilla's Hyper Beam had RECHARGE_AFTER, which is); effect 182
      // (LOWER_OWN_ATK_AND_DEF) is.
      for (const move of [M.HYPER_BEAM, M.HYDRO_CANNON, M.SUPERPOWER]) px({ moves: [move], effect: E.RECOIL_QUARTER }, '0');
      for (const move of [M.TAKE_DOWN, M.CLOSE_COMBAT, M.BRAVE_BIRD]) px({ moves: [move], effect: E.LOWER_OWN_ATK_AND_DEF }, PLUS_2_EXTREMES);
    });
  });

  describe('Baton Pass', () => {
    const bp = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_BATON_PASS, setup, expected);

    it('no party member left alive, or a damaging move: no change', () => {
      bp({ moves: [M.SWORDS_DANCE, M.BATON_PASS], aiBench: 0 }, '0');
      bp({ moves: [M.TACKLE, M.BATON_PASS] }, '0');
    });

    it('not knowing Baton Pass: 31.25% no change', () => {
      bp({ moves: [M.SWORDS_DANCE] }, '80/256: 0, 176/256: +5'); // IfRandomLessThan 80 (script.s:6577)
    });

    it('Step 1: Swords Dance, Dragon Dance, Calm Mind, Nasty Plot: turn 1 +5; else +1 at 60% HP or more, -10 below', () => {
      // Gist error: the two rules don't add up. Turn 1's +5 ends the routine (IfLoadedEqualTo 0, ScorePlus5,
      // script.s:6596–6597), so the HP rule only runs on later turns (:6600–6603): +5, or +1 or -10, never both.
      bp({ moves: [M.SWORDS_DANCE, M.BATON_PASS], ai: { hp: hp(59) } }, '+5');
      for (const move of [M.SWORDS_DANCE, M.DRAGON_DANCE, M.CALM_MIND, M.NASTY_PLOT]) {
        bp({ moves: [move, M.BATON_PASS] }, '+5');
        bp({ moves: [move, M.BATON_PASS], turn: 1 }, '+1');
        bp({ moves: [move, M.BATON_PASS], turn: 1, ai: { hp: hp(60) } }, '+1');
        bp({ moves: [move, M.BATON_PASS], turn: 1, ai: { hp: hp(59) } }, '-10');
      }
    });

    it('Step 2: Protect, Detect: -2 after Protect or Detect, else +2', () => {
      bp({ moves: [M.PROTECT, M.BATON_PASS], effect: E.PROTECT }, '+2');
      bp({ moves: [M.PROTECT, M.BATON_PASS], ai: { prevMove: M.PROTECT } }, '-2');
      bp({ moves: [M.DETECT, M.BATON_PASS], ai: { prevMove: M.PROTECT } }, '-2');
      bp({ moves: [M.PROTECT, M.BATON_PASS], ai: { prevMove: M.DETECT } }, '-2');
      bp({ moves: [M.PROTECT, M.BATON_PASS], ai: { prevMove: M.TACKLE } }, '+2');
    });

    it('Step 3: Baton Pass: turn 1 -2; +3, +2, +1 for Attack or Special Attack at +3, +2, +1', () => {
      bp({ moves: [M.BATON_PASS] }, '-2');
      // The turn-1 -2 ends the routine (ScoreMinus2): no stage bonus then.
      bp({ moves: [M.BATON_PASS], ai: { stages: { attack: 3 } } }, '-2');
      bp({ moves: [M.BATON_PASS], turn: 1 }, '0');
      bp({ moves: [M.BATON_PASS], turn: 1, ai: { stages: { attack: 3 } } }, '+3');
      bp({ moves: [M.BATON_PASS], turn: 1, ai: { stages: { attack: 2 } } }, '+2');
      bp({ moves: [M.BATON_PASS], turn: 1, ai: { stages: { attack: 1 } } }, '+1');
      bp({ moves: [M.BATON_PASS], turn: 1, ai: { stages: { spAttack: 2 } } }, '+2');
      // Attack is checked first, and the first bonus ends the routine (script.s:6626–6631).
      bp({ moves: [M.BATON_PASS], turn: 1, ai: { stages: { attack: 1, spAttack: 3 } } }, '+1');
    });

    it('Step 4: any other move: ~92% +3', () => {
      // Gist error: after the +3 the script falls through into BatonPass_SetupAtHighHP (script.s:6590–6594), so the
      // move also gets Step 1's +5 on turn 1, else +1 or -10 by HP.
      bp({ moves: [M.HOWL, M.BATON_PASS] }, '20/256: 0, 236/256: +8');
      bp({ moves: [M.HOWL, M.BATON_PASS], turn: 1 }, '20/256: 0, 236/256: +4');
      bp({ moves: [M.HOWL, M.BATON_PASS], turn: 1, ai: { hp: hp(50) } }, '20/256: 0, 236/256: -7');
    });
  });

  describe('Tag Strategy', () => {
    const tag = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_TAG_STRATEGY, setup, expected);
    /** A stronger second move, so the one under test isn't the highest damage (CheckIfHighestDamageWithPartner). */
    const beside = (move: number): number[] => [move, M.MEGA_KICK];

    describe('If targeting a partner (never in singles)', () => {
      // In singles the target is always the player, so TagStrategy_Partner (script.s:7339) never runs: each move the
      // section scores is scored as any move used on the opponent. None gets the section's -30, +10, +5 or +3.
      it('no partner left: -30', () => {
        tag({ moves: [M.HOWL] }, '0');
      });

      it('no check matches: -30', () => {
        tag({ moves: [M.SPIKES] }, '0');
      });

      it('Skill Swap: a Truant or Slow Start partner +10; Levitate to an Electric partner +1/+2; Compound Eyes or No Guard to an inaccurate partner +3', () => {
        tag({ moves: [M.SKILL_SWAP], player: { ability: A.TRUANT } }, '0');
        tag({ moves: [M.SKILL_SWAP], ai: { ability: A.LEVITATE }, player: { types: [TYPE_ELECTRIC, TYPE_ELECTRIC] } }, '0');
      });

      it('Will-O-Wisp: a Flash Fire partner +3; a Guts partner +5', () => {
        tag({ moves: [M.WILL_O_WISP], player: { ability: A.FLASH_FIRE } }, '0');
        tag({ moves: [M.WILL_O_WISP], player: { ability: A.GUTS } }, '0');
      });

      it('Thunder Wave: a Ground partner -30; Motor Drive or Volt Absorb as an Electric move', () => {
        tag({ moves: [M.THUNDER_WAVE], player: { types: [TYPE_GROUND, TYPE_GROUND] } }, '0');
        tag({ moves: [M.THUNDER_WAVE], player: { ability: A.VOLT_ABSORB } }, '0');
      });

      it('Poison-inducing moves: a healthy Poison Heal partner +5', () => {
        tag({ moves: [M.TOXIC], player: { ability: A.POISON_HEAL } }, '0');
      });

      it('Helping Hand: 75% +2, 25% -1', () => {
        tag({ moves: [M.HELPING_HAND] }, '0');
      });

      it('Swagger: a partner with Persim or Lum Berry and under +2 Attack +3', () => {
        tag({ moves: [M.SWAGGER], player: { item: I.PERSIM_BERRY } }, '0');
      });

      it('Gastro Acid: a Truant or Slow Start partner +5', () => {
        tag({ moves: [M.GASTRO_ACID], player: { ability: A.TRUANT } }, '0');
      });

      it('Acupressure: by the partner\'s stages and HP', () => {
        tag({ moves: [M.ACUPRESSURE] }, '0');
      });

      it('Damaging Fire moves: a partner with Flash Fire not yet active +3, else -30', () => {
        tag({ moves: beside(M.FLAMETHROWER), player: { ability: A.FLASH_FIRE } }, '0'); // as Other Fire-Type Moves
      });

      it('Damaging Electric moves: a Motor Drive partner 37.5% +3 (-30 at +6 Speed); a Volt Absorb partner by its HP; else -30', () => {
        tag({ moves: beside(M.THUNDERBOLT), player: { ability: A.MOTOR_DRIVE } }, '0'); // as Other Electric-Type Moves
        tag({ moves: beside(M.THUNDERBOLT), player: { ability: A.VOLT_ABSORB, hp: hp(50) } }, '0');
      });

      it('Damaging Water moves: a Water Absorb or Dry Skin partner by its HP', () => {
        tag({ moves: beside(M.HYDRO_PUMP), player: { ability: A.WATER_ABSORB, hp: hp(50) } }, '-1'); // as Other Water-Type Moves
      });
    });

    describe('If targeting an opponent', () => {
      it("Effectiveness 1. not very effective and no kill: 75% -1 (singles: the absent partner's HP reads 0%, so no -1)", () => {
        // Gist error (omission): before the roll, IfHPPercentEqualTo AI_BATTLER_DEFENDER_PARTNER, 0 skips it when the
        // target's partner is at 0% (script.s:6663). In singles that is the empty slot 2, HP 0/0, which the cartridge's
        // divide reads as 0%, so the -1 never comes: Tackle (the only move, so the highest damage) keeps just
        // the Highest Damage 2 coin.
        // This case pins the 0/0 = 0 reading: a throwing divide fails it with DIV_ZERO, and any non-zero reading of the
        // empty slot would bring back the 192/256 -1.
        tag({ moves: [M.TACKLE], player: { types: [TYPE_ROCK, TYPE_ROCK] } }, '128/256: +1, 128/256: 0');
        // A kill skips the read too (script.s:6660), with the same result.
        tag({ moves: [M.TACKLE], player: { types: [TYPE_ROCK, TYPE_ROCK], hp: 1 } }, '128/256: +1, 128/256: 0');
        // Control, not a singles state: a live Pokémon in slot 2 makes the partner's HP 100%, and the gist's 75% -1
        // comes back (IfRandomLessThan 64, script.s:6666), before the same coin.
        tag({
          moves: [M.TACKLE], player: { types: [TYPE_ROCK, TYPE_ROCK] },
          patch: (v) => { v.mons[2] = { ...v.mons[0], curHP: 100, maxHP: 100 }; },
        }, '128/256: 0, 96/256: -1, 32/256: +1');
      });

      it("Effectiveness 2. doubly ineffective and no kill: 75% -2 (singles: the absent partner's HP reads 0%, so no -2)", () => {
        // Gist error (omission): as in 1, the target's partner at 0% skips the roll (script.s:6675).
        tag({ moves: [M.TACKLE], player: { types: [TYPE_ROCK, TYPE_STEEL] } }, '128/256: +1, 128/256: 0');
      });

      it('Effectiveness 3. super effective: ~61% +1', () => {
        tag({ moves: beside(M.BRICK_BREAK) }, '156/256: +1, 100/256: 0'); // IfRandomLessThan 100 (script.s:6722)
      });

      it('Effectiveness 4. doubly super effective: 75% +1', () => {
        // Hyper Voice from a high Special Attack, so the 4× Brick Break isn't the highest damage.
        tag({ moves: [M.BRICK_BREAK, M.HYPER_VOICE], ai: { spAttack: 300 }, player: { types: [TYPE_NORMAL, TYPE_ICE], maxHP: 400 } }, '192/256: +1, 64/256: 0');
      });

      it('Effectiveness: none for flat-damage or OHKO moves', () => {
        tag({ moves: beside(M.SEISMIC_TOSS) }, '0'); // super effective on a Normal type, but flat (script.s:6707–6712)
        tag({ moves: [M.GUILLOTINE], player: { types: [TYPE_ROCK, TYPE_ROCK] } }, '0'); // never damage-scored
      });

      it('Highest Damage 1. the Priority +1 effect: ~80.5% +1, skipping the super-effective check', () => {
        tag({ moves: [M.QUICK_ATTACK] }, '206/256: +1, 50/256: 0'); // IfRandomLessThan 50 (script.s:6702)
      });

      it('Highest Damage 2. otherwise: 50% +1, skipping the super-effective check', () => {
        tag({ moves: [M.TACKLE] }, '128/256: +1, 128/256: 0');
        // Super effective and the highest: the +1 for the highest or, without it, the super-effective draw.
        tag({ moves: [M.BRICK_BREAK] }, '52736/65536: +1, 12800/65536: 0');
      });

      it('Skill Swap: our Truant, Slow Start, Stall or Klutz +5; their Shadow Tag, Pure Power, Huge Power, Mold Breaker, Solid Rock, Filter or Flower Gift +2', () => {
        tag({ moves: [M.SKILL_SWAP], effect: E.SWITCH_ABILITIES }, '0');
        for (const ability of [A.TRUANT, A.SLOW_START, A.STALL, A.KLUTZ]) tag({ moves: [M.SKILL_SWAP], ai: { ability } }, '+5');
        for (const ability of [A.SHADOW_TAG, A.PURE_POWER, A.HUGE_POWER, A.MOLD_BREAKER, A.SOLID_ROCK, A.FILTER, A.FLOWER_GIFT]) {
          tag({ moves: [M.SKILL_SWAP], player: { ability } }, '+2');
        }
      });

      it('Earthquake, Magnitude: a Levitate, Flying or Magnet Rise partner +2; Fire, Electric, Poison or Rock -10; else -3', () => {
        // Singles: the partner is the empty slot 3, so neither check holds: -3, as the script's note says (script.s:7133).
        tag({ moves: beside(M.EARTHQUAKE) }, '-3');
        // Hack: Bulldoze keeps Magnitude's ID (222), which TagStrategy_CheckSpecialScoring tests (script.s:6737).
        tag({ moves: beside(M.MAGNITUDE), effect: E.LOWER_SPEED_HIT }, '-3');
      });

      it("Future Sight, Doom Desire: a partner who also knows one (singles: the absent partner's HP reads 0%, so nothing)", () => {
        // Singles: IfHPPercentEqualTo AI_BATTLER_ATTACKER_PARTNER, 0 (script.s:7156) reads the empty slot 3 as 0% and
        // ends the routine, as the gist's "no partner" rule says. Each move here is the only one, so the highest damage,
        // and keeps just the Highest Damage 2 coin.
        tag({ moves: [M.FUTURE_SIGHT] }, '128/256: +1, 128/256: 0');
        // Doom Desire is routed by its move ID (IfMoveEqualTo MOVE_DOOM_DESIRE, script.s:6739), to the same read.
        tag({ moves: [M.DOOM_DESIRE], effect: E.HIT_IN_3_TURNS }, '128/256: +1, 128/256: 0');
      });

      it('Rain Dance: Hydration and statused +2; Dry Skin +2 (for us and our partner)', () => {
        tag({ moves: [M.RAIN_DANCE] }, '0');
        tag({ moves: [M.RAIN_DANCE], ai: { ability: A.DRY_SKIN } }, '+2');
        tag({ moves: [M.RAIN_DANCE], ai: { ability: A.HYDRATION, status: MON_CONDITION_BURN } }, '+2');
        tag({ moves: [M.RAIN_DANCE], ai: { ability: A.HYDRATION } }, '0');
      });

      it('Sunny Day: Leaf Guard (healthy, 30% HP or more) +2; Flower Gift +2; Dry Skin -2; Solar Power +1 at 50% HP or more, else 50% -2', () => {
        tag({ moves: [M.SUNNY_DAY] }, '0');
        tag({ moves: [M.SUNNY_DAY], ai: { ability: A.LEAF_GUARD } }, '+2');
        tag({ moves: [M.SUNNY_DAY], ai: { ability: A.LEAF_GUARD, hp: hp(30) } }, '+2');
        tag({ moves: [M.SUNNY_DAY], ai: { ability: A.LEAF_GUARD, hp: hp(29) } }, '0');
        tag({ moves: [M.SUNNY_DAY], ai: { ability: A.LEAF_GUARD, status: MON_CONDITION_POISON } }, '0');
        tag({ moves: [M.SUNNY_DAY], ai: { ability: A.FLOWER_GIFT } }, '+2');
        tag({ moves: [M.SUNNY_DAY], ai: { ability: A.DRY_SKIN } }, '-2');
        // Gist error: after Solar Power's +1 the script falls through into the 50% -2 (script.s:6815–6821).
        tag({ moves: [M.SUNNY_DAY], ai: { ability: A.SOLAR_POWER } }, '128/256: +1, 128/256: -1');
        tag({ moves: [M.SUNNY_DAY], ai: { ability: A.SOLAR_POWER, hp: hp(49) } }, '128/256: 0, 128/256: -2');
      });

      it('Hail: Ice Body +2; Snow Cloak +2; knowing Blizzard +2', () => {
        tag({ moves: [M.HAIL] }, '0');
        tag({ moves: [M.HAIL], ai: { ability: A.ICE_BODY } }, '+2');
        tag({ moves: [M.HAIL], ai: { ability: A.SNOW_CLOAK } }, '+2');
        tag({ moves: [M.HAIL, M.BLIZZARD] }, '+2');
      });

      it('Sandstorm: Sand Veil +2; a Rock type +2', () => {
        tag({ moves: [M.SANDSTORM] }, '0');
        tag({ moves: [M.SANDSTORM], ai: { ability: A.SAND_VEIL } }, '+2');
        // Singles: LOAD_ATTACKER_PARTNER_TYPE_* reads BattleSystem_GetPartner, the attacker itself (battle_system.c:394;
        // trainer_ai.c:965–978), so a Rock type gets the partner's +2 as well (script.s:6906–6909).
        tag({ moves: [M.SANDSTORM], ai: { types: [TYPE_ROCK, TYPE_ROCK] } }, '+4');
        tag({ moves: [M.SANDSTORM], ai: { types: [TYPE_NORMAL, TYPE_ROCK] } }, '+4');
      });

      it('Gravity: already up -30; -5 per ally with Levitate, Flying or Magnet Rise; 75% +3 per such opponent', () => {
        tag({ moves: [M.GRAVITY] }, '0');
        tag({ moves: [M.GRAVITY], field: FIELD_CONDITION_GRAVITY_INIT }, '-30');
        tag({ moves: [M.GRAVITY], ai: { types: [TYPE_NORMAL, TYPE_FLYING] } }, '-5');
        tag({ moves: [M.GRAVITY], ai: { ability: A.LEVITATE } }, '-5');
        tag({ moves: [M.GRAVITY], ai: { moveEffectsMask: MOVE_EFFECT_MAGNET_RISE } }, '-5');
        tag({ moves: [M.GRAVITY], player: { ability: A.LEVITATE } }, '192/256: +3, 64/256: 0');
        tag({ moves: [M.GRAVITY], player: { types: [TYPE_FLYING, TYPE_FLYING] } }, '192/256: +3, 64/256: 0');
        tag({ moves: [M.GRAVITY], ai: { types: [TYPE_FLYING, TYPE_FLYING] }, player: { types: [TYPE_FLYING, TYPE_FLYING] } }, '192/256: -2, 64/256: -5');
      });

      it("Trick Room: one active Pokémon on a side -30 (singles: the absent partner's HP reads 0%, so always -30)", () => {
        // Singles: IfHPPercentEqualTo AI_BATTLER_ATTACKER_PARTNER, 0 reads the empty slot 3 as 0% (script.s:6981), so
        // Trick Room gets the gist's -30 before the speed order is read.
        tag({ moves: [M.TRICK_ROOM] }, '-30');
        tag({ moves: [M.TRICK_ROOM], ai: { speed: 10 } }, '-30');
      });

      it("Follow Me: by our HP and our partner's (singles: the absent partner's HP reads 0%, its lowest band)", () => {
        // Singles: the partner's HP checks (script.s:7057–7059, 7063–7065, 7069–7071) read the empty slot 3 as 0%, so
        // every band takes the gist's "otherwise" row: over 90% 192/256 +3, over 50% or 30% 192/256 +2.
        tag({ moves: [M.FOLLOW_ME], effect: E.MAKE_GLOBAL_TARGET }, '192/256: +3, 64/256: 0');
        tag({ moves: [M.FOLLOW_ME], ai: { hp: hp(91) } }, '192/256: +3, 64/256: 0');
        tag({ moves: [M.FOLLOW_ME], ai: { hp: hp(90) } }, '192/256: +2, 64/256: 0');
        tag({ moves: [M.FOLLOW_ME], ai: { hp: hp(31) } }, '192/256: +2, 64/256: 0');
        tag({ moves: [M.FOLLOW_ME], ai: { hp: hp(30) } }, '192/256: -5, 64/256: 0'); // no partner read
      });

      it('Discharge: a Motor Drive or Volt Absorb partner +3; Water or Flying -10; Ground +3; else -3', () => {
        tag({ moves: beside(M.DISCHARGE), effect: E.PARALYZE_HIT }, '-3'); // singles: no partner to match
      });

      it('Other Electric moves: Lightning Rod on their partner -1 (-8 more if Ground); on ours -10', () => {
        tag({ moves: beside(M.THUNDERBOLT) }, '0');
      });

      it('Lava Plume: our Flash Fire +1 more; a Dry Skin partner -3; Flash Fire +3; Grass, Steel, Ice or Bug -10; else -3', () => {
        tag({ moves: beside(M.LAVA_PLUME), effect: E.BURN_HIT }, '-3');
        tag({ moves: beside(M.LAVA_PLUME), ai: { effects: { flashFire: true } } }, '-2');
      });

      it('Other Fire moves: our Flash Fire active +1', () => {
        tag({ moves: beside(M.FLAMETHROWER) }, '0');
        tag({ moves: beside(M.FLAMETHROWER), ai: { effects: { flashFire: true } } }, '+1');
      });

      it('Surf: a Dry Skin or Water Absorb partner +3; Ground or Fire -10; else -3', () => {
        tag({ moves: beside(M.SURF), effect: E.DOUBLE_DAMAGE_DIVE }, '-3');
      });

      it("Other Water moves: Storm Drain on their partner -1; on ours -10", () => {
        // Singles: CheckBattlerAbility on the empty slot 2 gives AI_UNKNOWN, and the script skips the -1 only on
        // AI_NOT_HAVE (script.s:7271–7273): every other Water move gets -1.
        tag({ moves: beside(M.HYDRO_PUMP) }, '-1');
      });

      it('Partner knows Helping Hand: +1 to other damaging moves', () => {
        // Singles: IfMoveKnown AI_BATTLER_ATTACKER_PARTNER never jumps for a 0-HP slot (trainer_ai.c:1650–1653).
        tag({ moves: beside(M.TACKLE) }, '0');
      });
    });
  });

  describe('Check HP', () => {
    const hp100 = { hp: hp(100) };
    const ck = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_CHECK_HP, setup, expected);

    describe("Phase 1: the attacker's HP (the target at full HP)", () => {
      it('Self-Destruct / Explosion: 31% HP or more: 80.5% -2', () => {
        ck({ moves: [M.EXPLOSION] }, MINUS_2_CHECK_HP);
        ck({ moves: [M.EXPLOSION], ai: { hp: hp(31) } }, MINUS_2_CHECK_HP);
        ck({ moves: [M.EXPLOSION], ai: { hp: hp(30) } }, '0');
      });

      it('Recovery moves, Rest, Destiny Bond, Flail, Reversal, Memento, Healing Wish, Lunar Dance, Grudge: 71% HP or more: 80.5% -2', () => {
        // Endure too (SURVIVE_WITH_1_HP, script.s:7754), which the gist leaves out.
        const moves = [M.RECOVER, M.MORNING_SUN, M.ROOST, M.REST, M.DESTINY_BOND, M.FLAIL, M.REVERSAL, M.ENDURE, M.GRUDGE, M.LUNAR_DANCE];
        for (const move of moves) {
          ck({ moves: [move], ai: { hp: hp(71) } }, MINUS_2_CHECK_HP);
          ck({ moves: [move], ai: { hp: hp(70) } }, '0');
        }
        // Hack: Memento has Explosion's effect, which this phase also discourages from 31% (CheckHP_DiscourageAtMediumHP);
        // the hack's 361 (HP Electric) is a plain hit.
        ck({ moves: [M.MEMENTO], ai: { hp: hp(50) } }, MINUS_2_CHECK_HP);
        ck({ moves: [M.HEALING_WISH] }, '0');
      });

      it('Stat boosts and drops, Focus Energy, Bide, Conversion, Conversion 2, Light Screen, Mist, Safeguard, Belly Drum: under 70% HP: 80.5% -2', () => {
        // The phase tests IfHPPercentGreaterThan 70 (script.s:7700): 70% exactly is discouraged, as are 31–69%.
        const moves = [
          M.HOWL, M.SWORDS_DANCE, M.AGILITY, M.GROWL, M.SCREECH, M.FOCUS_ENERGY, M.CONVERSION_2, M.LIGHT_SCREEN, M.MIST,
          M.SAFEGUARD, M.BELLY_DRUM, M.TICKLE, M.BULK_UP, M.DRAGON_DANCE,
        ];
        for (const move of moves) {
          ck({ moves: [move], ai: { hp: hp(70) } }, MINUS_2_CHECK_HP);
          ck({ moves: [move], ai: { hp: hp(30) } }, MINUS_2_CHECK_HP);
          ck({ moves: [move], ai: { hp: hp(71) } }, '0');
        }
        // Hack: Bide has Metal Burst's effect, which only the 30%-or-less table names.
        ck({ moves: [M.BIDE], ai: { hp: hp(50) } }, '0');
        noHackMove(E.CONVERSION);
      });

      it('Lucky Chant, Power Swap, Guard Swap: 31% to 70% HP: 80.5% -2', () => {
        for (const move of [M.LUCKY_CHANT, M.POWER_SWAP, M.GUARD_SWAP]) {
          ck({ moves: [move], ai: { hp: hp(70) } }, MINUS_2_CHECK_HP);
          ck({ moves: [move], ai: { hp: hp(31) } }, MINUS_2_CHECK_HP);
          ck({ moves: [move], ai: { hp: hp(30) } }, '0');
          ck({ moves: [move], ai: { hp: hp(71) } }, '0');
        }
      });

      it('Rage, Lock On, Psych Up, Mirror Coat, Metal Burst, Water Spout, Eruption, Mud Sport, Water Sport, Acupressure: 30% HP or less: 80.5% -2', () => {
        for (const move of [M.LOCK_ON, M.MIND_READER, M.PSYCH_UP, M.MIRROR_COAT, M.METAL_BURST, M.BIDE, M.WATER_SPOUT, M.ACUPRESSURE]) {
          ck({ moves: [move], ai: { hp: hp(30) } }, MINUS_2_CHECK_HP);
          ck({ moves: [move], ai: { hp: hp(31) } }, '0');
        }
        // Hack: Rage has Pursuit's effect, Eruption Flare Blitz's, and the hack's 300 and 346 are HP Ground and Scald;
        // no move has Rage's, Mud Sport's or Water Sport's vanilla effect.
        for (const move of [M.RAGE, M.ERUPTION, M.MUD_SPORT, M.WATER_SPORT]) ck({ moves: [move], ai: { hp: hp(30) } }, '0');
        noHackMove(E.RAISE_ATK_WHEN_HIT, E.HALVE_ELECTRIC_DAMAGE, E.HALVE_FIRE_DAMAGE);
      });
    });

    describe("Phase 2: the target's HP", () => {
      it('the target at 71% HP or more: no change', () => {
        ck({ moves: [M.HOWL], ai: hp100, player: { hp: hp(71) } }, '0');
        ck({ moves: [M.HYPNOSIS], ai: hp100, player: { hp: hp(71) } }, '0');
      });

      it('Stat boosts and drops, Poison Gas, Mist, Pain Split, Safeguard, Acupressure, Wring Out, Perish Song: 80.5% -2', () => {
        // The attacker at full HP, where Phase 1 discourages none of these. Focus Energy (CRIT_UP_2) is in both target
        // tables too (script.s:7885, 7939), which the gist leaves out.
        const moves = [M.HOWL, M.GROWL, M.POISON_POWDER, M.MIST, M.PAIN_SPLIT, M.SAFEGUARD, M.ACUPRESSURE, M.PERISH_SONG, M.FOCUS_ENERGY];
        for (const move of moves) {
          ck({ moves: [move], ai: hp100, player: { hp: hp(70) } }, MINUS_2_CHECK_HP);
          ck({ moves: [move], ai: hp100, player: { hp: hp(30) } }, MINUS_2_CHECK_HP);
        }
        // Hack: Poison Gas badly poisons (Toxic's effect), which only the 30%-or-less table names; Wring Out has Brine's
        // effect, and no move has its vanilla one.
        ck({ moves: [M.POISON_GAS], effect: E.STATUS_BADLY_POISON, ai: hp100, player: { hp: hp(50) } }, '0');
        ck({ moves: [M.POISON_GAS], ai: hp100, player: { hp: hp(30) } }, MINUS_2_CHECK_HP);
        ck({ moves: [M.WRING_OUT], effect: E.DOUBLE_POWER_WHEN_BELOW_HALF, ai: hp100, player: { hp: hp(50) } }, '0');
        noHackMove(E.INCREASE_POWER_WITH_MORE_HP);
      });

      it('Condition-inducing moves, Bide, Conversion, Conversion 2, Toxic, Light Screen, OHKO moves, Super Fang, Lock On, Spite, Fury Cutter, Rollout, Psych Up, Mirror Coat, Explosion, Self-Destruct: the target at 30% or less: 80.5% -2', () => {
        const moves = [
          M.HYPNOSIS, M.TOXIC, M.POISON_POWDER, M.THUNDER_WAVE, M.WILL_O_WISP, M.CONFUSE_RAY, M.SWAGGER, M.ATTRACT,
          M.CONVERSION_2, M.LIGHT_SCREEN, M.GUILLOTINE, M.SUPER_FANG, M.LOCK_ON, M.SPITE, M.PSYCH_UP, M.MIRROR_COAT,
        ];
        for (const move of moves) {
          ck({ moves: [move], ai: hp100, player: { hp: hp(30) } }, MINUS_2_CHECK_HP);
          ck({ moves: [move], ai: hp100, player: { hp: hp(31) } }, move === M.POISON_POWDER ? MINUS_2_CHECK_HP : '0');
        }
        // Explosion at 30% HP of our own, where Phase 1 leaves it be; at full HP both phases draw.
        ck({ moves: [M.EXPLOSION], ai: { hp: hp(30) }, player: { hp: hp(30) } }, MINUS_2_CHECK_HP);
        ck({ moves: [M.SELF_DESTRUCT], ai: hp100, player: { hp: hp(30) } }, '42436/65536: -4, 20600/65536: -2, 2500/65536: 0');
        // Hack: Fury Cutter has effect 88 and Rollout is a plain hit; no move has DOUBLE_POWER_EACH_TURN. Gist error
        // too: vanilla Rollout's effect (DOUBLE_POWER_EACH_TURN_LOCK_INTO) isn't in the table (script.s:7914–7977).
        // Hack: Bide has Metal Burst's effect, in no Phase 2 table.
        for (const move of [M.FURY_CUTTER, M.ROLLOUT, M.BIDE]) ck({ moves: [move], ai: hp100, player: { hp: hp(30) } }, '0');
        noHackMove(E.DOUBLE_POWER_EACH_TURN, E.CONVERSION);
      });
    });
  });

  describe('Weather', () => {
    const w = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_WEATHER, setup, expected);

    it('not the battle\'s first turn: no change', () => {
      for (const move of [M.SUNNY_DAY, M.RAIN_DANCE, M.SANDSTORM, M.HAIL, M.TACKLE]) w({ moves: [move], turn: 1 }, '0');
    });

    it('a weather move whose weather is not up: +5', () => {
      const weathers = [
        [M.SUNNY_DAY, E.WEATHER_SUN, FIELD_CONDITION_SUNNY_PERM], [M.RAIN_DANCE, E.WEATHER_RAIN, FIELD_CONDITION_RAINING_PERM],
        [M.SANDSTORM, E.WEATHER_SANDSTORM, FIELD_CONDITION_SANDSTORM_PERM], [M.HAIL, E.WEATHER_HAIL, FIELD_CONDITION_HAILING_PERM],
      ] as const;
      for (const [move, effect, field] of weathers) {
        w({ moves: [move], effect }, '+5');
        w({ moves: [move], field }, '0');
      }
      w({ moves: [M.RAIN_DANCE], field: FIELD_CONDITION_SUNNY_PERM }, '+5');
    });

    it('note: any other move gets +5 unless the sun is up', () => {
      // Gist error (omission): a move with no weather effect falls through into Weather_Sun (script.s:7987–7992),
      // which gives +5 unless the weather is sun.
      w({ moves: [M.TACKLE] }, '+5');
      w({ moves: [M.HOWL], field: FIELD_CONDITION_RAINING_PERM }, '+5');
      w({ moves: [M.TACKLE], field: FIELD_CONDITION_SUNNY_PERM }, '0');
    });
  });

  describe('Harassment', () => {
    const h = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_HARRASSMENT, setup, expected);

    it('a harassing move: 50% +2', () => {
      const moves = [
        M.HYPNOSIS, M.GROWL, M.LEER, M.SAND_ATTACK, M.SWEET_SCENT, M.CONFUSE_RAY, M.CHARM, M.SCREECH, M.SCARY_FACE,
        M.KINESIS, M.POISON_POWDER, M.THUNDER_WAVE, M.WILL_O_WISP, M.ATTRACT, M.LEECH_SEED, M.ENCORE, M.SPITE, M.SPIKES,
        M.SWAGGER, M.FLATTER, M.TORMENT, M.NATURE_POWER, M.KNOCK_OFF, M.IMPRISON, M.SECRET_POWER, M.TICKLE,
        M.CAMOUFLAGE, M.EMBARGO, M.PSYCHO_SHIFT, M.TOXIC_SPIKES, M.DEFOG, M.CAPTIVATE,
      ];
      for (const move of moves) h({ moves: [move] }, PLUS_2_HALF);
      h({ moves: [M.TACKLE] }, '0');
      // A one-stage Speed or Special Defense drop isn't in the table.
      h({ moves: [M.STRING_SHOT] }, '0');
      // Gist error: "Poison" among the condition-inducing moves is STATUS_POISON alone; Harrassment_Effects
      // (script.s:8036–8072) has no STATUS_BADLY_POISON, so Toxic gets nothing.
      h({ moves: [M.TOXIC] }, '0');
    });
  });
});
