// Real-data check: every Expert-flag scoring rule in lhearachel's Gen 4 trainer AI gist
// (https://gist.github.com/lhearachel/ff61af1f58c84c96592b0b8184dba096), run on the hack's own AI script and move data
// (gistCase, aiGistCases.ts). Each case checks the slot's exact score change and its odds.
//
// The decompilation's src/battle/trainer_ai/script.s (pret/pokeplatinum 62bdaacdc) is the source of truth; the hack's
// Expert routines match it word for word (docs/ai-changes.md: "Expert (bit 2): No change"). Expert_Main
// (script.s:1623–1811) picks one routine by the current move's effect. Conventions as in aiGist.test.ts: where the gist
// and the script disagree, the case expects the script and says "Gist error" with the line that wins; where the hack's
// move data differs, the case expects the hack and says "Hack:". A routine whose effect is on no hack move can't fire in
// the hack: its case checks that (noHackMove) and pins what the moves the gist names do instead.
//
// The defaults (aiGistCases.ts): turn 0, the AI's first turn in battle; both sides Normal at 100% of 200 HP; the AI
// slower (Speed 90 against the player's 110). The player hasn't moved, so movePrevByBattler is MOVE_NONE, whose move
// record has power 0 and class Physical: a routine that reads the target's last move sees a Physical move with no power.
//
// `IfRandomLessThan n` jumps with n/256 (trainer_ai.c:528–538). A speed tie is never COMPARE_SPEED_SLOWER:
// BattleSystem_CompareBattlerSpeed draws a coin between _FASTER and _TIE (battle_lib.c:1188), so a routine testing
// "slower" treats a tie as faster, and one testing "faster" draws.

import { describe, expect, it } from 'vitest';
import {
  AI_FLAG_EXPERT, FIELD_CONDITION_HAILING_PERM, FIELD_CONDITION_RAINING_PERM, FIELD_CONDITION_SANDSTORM_PERM,
  FIELD_CONDITION_SUNNY_PERM, MON_CONDITION_BURN, MON_CONDITION_PARALYSIS, MON_CONDITION_POISON, MON_CONDITION_TOXIC,
  MOVE_EFFECT_AQUA_RING, MOVE_EFFECT_INGRAIN, MOVE_EFFECT_LEECH_SEED, MOVE_EFFECT_LOCK_ON_0, MOVE_EFFECT_MAGNET_RISE,
  MOVE_EFFECT_PERISH_SONG, MOVE_EFFECT_YAWN_0, SIDE_CONDITION_LIGHT_SCREEN, SIDE_CONDITION_REFLECT, SIDE_CONDITION_SPIKES,
  SIDE_CONDITION_STEALTH_ROCK, SIDE_CONDITION_TOXIC_SPIKES, TYPE_DARK, TYPE_ELECTRIC, TYPE_FIGHTING, TYPE_FIRE,
  TYPE_FLYING, TYPE_GHOST, TYPE_GRASS, TYPE_GROUND, TYPE_ICE, TYPE_NORMAL, TYPE_POISON, TYPE_PSYCHIC, TYPE_ROCK,
  TYPE_STEEL, TYPE_WATER, VOLATILE_CONDITION_ATTRACT_0, VOLATILE_CONDITION_CONFUSION_0, VOLATILE_CONDITION_CURSE,
  VOLATILE_CONDITION_SUBSTITUTE,
} from '../../src/ai/constants.js';
import { PATHS } from '../../src/ai/lib/known.js';
import type { AiView } from '../../src/ai/view.js';
import { A, E, type Expected, gistCase, type GistSetup, hackEffect, I, M, noHackMove, type StageName } from './aiGistCases.js';
import { needFiles, PK_ROM } from './env.js';

const suite = needFiles("the gist's Expert scoring rules on the hack's AI script", { PK_ROM });

/** One case under the Expert flag alone. */
const x = (setup: GistSetup, expected: Expected) => gistCase(AI_FLAG_EXPERT, setup, expected);

/** HP out of the default 200 for a percentage (curHP * 100 / maxHP, truncated, trainer_ai.c:596). */
const hp = (percent: number) => percent * 2;
/** A sleep counter of 2: asleep (MON_CONDITION_SLEEP is the counter's 3 bits). */
const ASLEEP = 2;
/** AI Speeds: faster than the player's 110, and tied with it. */
const FAST = 130;
const TIE = 110;
/** The AI's battler slot and the player's. */
const AI = 1;
const PLAYER = 0;

const ghost: [number, number] = [TYPE_GHOST, TYPE_GHOST];
const dark: [number, number] = [TYPE_DARK, TYPE_DARK];
const psychic: [number, number] = [TYPE_PSYCHIC, TYPE_PSYCHIC];

/** IfRandomLessThan 128 skips, else +1 / +2. */
const HALF_PLUS_1 = '1/2: +1, 1/2: 0';
const HALF_PLUS_2 = '1/2: +2, 1/2: 0';
/** The view as it stands after `battler` used Protect, Detect or Endure (LoadProtectChain, trainer_ai.c:2538–2552). */
const lastProtect = (battler: number, move: number = M.PROTECT) => (v: AiView) => { v.moveProtect[battler] = move; };

describe.skipIf(suite.skip)(suite.title, () => {
  describe('Sleep-inducing status moves (Expert_StatusSleep, script.s:1813)', () => {
    it('knows a Dream Eater or Nightmare move: 1/2 +1', () => {
      x({ moves: [M.HYPNOSIS], effect: E.STATUS_SLEEP }, '0');
      x({ moves: [M.HYPNOSIS, M.DREAM_EATER] }, HALF_PLUS_1); // IfMoveEffectKnown on our own moves (script.s:1816)
      x({ moves: [M.SING, M.DREAM_EATER], effect: E.STATUS_SLEEP }, HALF_PLUS_1);
      x({ moves: [M.SLEEP_POWDER, M.DREAM_EATER], effect: E.STATUS_SLEEP }, HALF_PLUS_1);
      // Hack: Yawn puts to sleep at once (STATUS_SLEEP; vanilla STATUS_SLEEP_NEXT_TURN), so it takes this routine.
      x({ moves: [M.YAWN, M.DREAM_EATER], effect: E.STATUS_SLEEP }, HALF_PLUS_1);
      // Hack: no move has Nightmare's effect (the hack's 171 is HP Ghost), so knowing "Nightmare" counts for nothing.
      noHackMove(E.STATUS_NIGHTMARE);
      x({ moves: [M.HYPNOSIS, M.NIGHTMARE] }, '0');
    });
  });

  describe('Poison-inducing status moves (Expert_StatusPoison, script.s:2929)', () => {
    const powder = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.POISON_POWDER], effect: E.STATUS_POISON, ...s });

    it("the attacker under 50% or the target at 50% or less: -1", () => {
      x(powder(), '0');
      x(powder({ ai: { hp: hp(49) } }), '-1');
      x(powder({ ai: { hp: hp(50) } }), '0');
      x(powder({ player: { hp: hp(50) } }), '-1');
      x(powder({ player: { hp: hp(51) } }), '0');
      x(powder({ ai: { hp: hp(49) }, player: { hp: hp(50) } }), '-1'); // one -1, not two
    });

    it("hack: Poison Gas takes Toxic's routine", () => {
      // Hack: Poison Gas badly poisons (STATUS_BADLY_POISON; vanilla STATUS_POISON), so Expert_ToxicLeechSeed scores it:
      // with no damaging move, nothing.
      x({ moves: [M.POISON_GAS], effect: E.STATUS_BADLY_POISON, ai: { hp: hp(49) } }, '0');
    });
  });

  describe('Paralysis-inducing status moves (Expert_StatusParalyze, script.s:2940)', () => {
    const wave = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.THUNDER_WAVE], effect: E.STATUS_PARALYZE, ...s });
    const LIKELY_PLUS_3 = '236/256: +3, 20/256: 0'; // IfRandomLessThan 20

    it('slower: 236/256 +3', () => {
      x(wave(), LIKELY_PLUS_3);
      x({ moves: [M.STUN_SPORE], effect: E.STATUS_PARALYZE }, LIKELY_PLUS_3);
      x({ moves: [M.GLARE], effect: E.STATUS_PARALYZE }, LIKELY_PLUS_3);
      x(wave({ ai: { speed: FAST } }), '0');
      x(wave({ ai: { speed: TIE } }), '0'); // a tie isn't slower
    });

    it("the attacker's HP at 70% or less: -1", () => {
      x(wave({ ai: { speed: FAST, hp: hp(70) } }), '-1');
      x(wave({ ai: { speed: FAST, hp: hp(71) } }), '0');
      // Gist error: a slower attacker never reaches the HP check; the +3 roll ends the routine (script.s:2944, 2949–2953).
      x(wave({ ai: { hp: hp(50) } }), LIKELY_PLUS_3);
    });
  });

  describe('Confusion-inducing status moves (Expert_StatusConfuse, Expert_Flatter, Expert_Swagger, script.s:2845–2891)', () => {
    const ray = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.CONFUSE_RAY], effect: E.STATUS_CONFUSE, ...s });

    it("the target's HP at 70% or less: 1/2 -1", () => {
      x(ray(), '0');
      x(ray({ player: { hp: hp(71) } }), '0');
      x(ray({ player: { hp: hp(70) } }), '1/2: -1, 1/2: 0');
      x({ moves: [M.SUPERSONIC], effect: E.STATUS_CONFUSE, player: { hp: hp(70) } }, '1/2: -1, 1/2: 0');
      x({ moves: [M.SWEET_KISS], effect: E.STATUS_CONFUSE, player: { hp: hp(70) } }, '1/2: -1, 1/2: 0');
      x({ moves: [M.TEETER_DANCE], effect: E.STATUS_CONFUSE, player: { hp: hp(70) } }, '1/2: -1, 1/2: 0');
    });

    it('also at 50% or less: -1 more', () => {
      x(ray({ player: { hp: hp(51) } }), '1/2: -1, 1/2: 0');
      x(ray({ player: { hp: hp(50) } }), '1/2: -2, 1/2: -1');
    });

    it('also at 30% or less: -1 more', () => {
      x(ray({ player: { hp: hp(31) } }), '1/2: -2, 1/2: -1');
      x(ray({ player: { hp: hp(30) } }), '1/2: -3, 1/2: -2');
    });

    it('Flatter: 1/2 +1 more', () => {
      x({ moves: [M.FLATTER], effect: E.SP_ATK_UP_CAUSE_CONFUSION }, HALF_PLUS_1);
      x({ moves: [M.FLATTER], player: { hp: hp(50) } }, '1/4: 0, 1/2: -1, 1/4: -2');
    });

    it('Swagger without Psych Up: as Flatter, 1/2 +1 more', () => {
      x({ moves: [M.SWAGGER], effect: E.ATK_UP_2_STATUS_CONFUSION }, HALF_PLUS_1);
      x({ moves: [M.SWAGGER], player: { hp: hp(30) } }, '1/4: -1, 1/2: -2, 1/4: -3');
    });

    it('Swagger with Psych Up: target Attack at -3 or higher -5; else +5 on the first turn, +3 after', () => {
      const swagger = (attack: number, s: Partial<GistSetup> = {}): GistSetup => ({
        moves: [M.SWAGGER, M.PSYCH_UP], player: { stages: { attack }, hp: hp(30) }, ...s,
      });
      x(swagger(0), '-5'); // the confusion checks are skipped: the target is at 30%
      x(swagger(-2), '-5');
      // Gist error: -3 gets the bonus, not -5. IfStatStageGreaterThan 3 is -2 or higher (script.s:2880).
      x(swagger(-3), '+5');
      x(swagger(-3, { turn: 1 }), '+3'); // LoadTurnCount is not 0 (script.s:2882–2883)
    });
  });

  describe('Draining attacks (Expert_DrainMove, script.s:1827; Expert_DreamEater, :1886)', () => {
    const LIKELY_MINUS_3 = '206/256: -3, 50/256: 0'; // IfRandomLessThan 50

    it('resisted or immune: 206/256 -3', () => {
      x({ moves: [M.GIGA_DRAIN], effect: E.RECOVER_HALF_DAMAGE_DEALT }, '0');
      x({ moves: [M.GIGA_DRAIN], player: { types: [TYPE_FIRE, TYPE_FIRE] } }, LIKELY_MINUS_3);
      x({ moves: [M.GIGA_DRAIN], player: { types: [TYPE_FIRE, TYPE_FLYING] } }, LIKELY_MINUS_3); // a quarter
      x({ moves: [M.DRAIN_PUNCH], effect: E.RECOVER_HALF_DAMAGE_DEALT, player: { types: ghost } }, LIKELY_MINUS_3);
      x({ moves: [M.ABSORB], effect: E.RECOVER_HALF_DAMAGE_DEALT, player: { types: dark } }, LIKELY_MINUS_3); // a Dark move in the hack
      // Hack: Heart Swap is a Water drain move (vanilla SWAP_STAT_CHANGES).
      x({ moves: [M.HEART_SWAP], effect: E.RECOVER_HALF_DAMAGE_DEALT, player: { types: [TYPE_GRASS, TYPE_GRASS] } }, LIKELY_MINUS_3);
    });

    it('Dream Eater: resisted or immune -1 instead', () => {
      x({ moves: [M.DREAM_EATER], effect: E.RECOVER_DAMAGE_SLEEP }, '0');
      x({ moves: [M.DREAM_EATER], player: { types: dark } }, '-1');
      x({ moves: [M.DREAM_EATER], player: { types: [TYPE_STEEL, TYPE_STEEL] } }, '-1');
      x({ moves: [M.DREAM_EATER], player: { types: [TYPE_STEEL, TYPE_STEEL], status: ASLEEP } }, '-1');
    });

    it('Dream Eater: not resisted and the target asleep: 205/256 +3', () => {
      x({ moves: [M.DREAM_EATER], player: { status: ASLEEP } }, '205/256: +3, 51/256: 0'); // IfRandomLessThan 51
    });
  });

  describe('Self-Destruct, Explosion, Memento (Expert_Explosion, script.s:1841)', () => {
    const boom = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.EXPLOSION], effect: E.HALVE_DEFENSE, ...s });
    const LIKELY_MINUS_1 = '206/256: -1, 50/256: 0';

    it('target evasion at +1 or more: -1 more', () => {
      x(boom(), LIKELY_MINUS_1);
      x(boom({ player: { stages: { evasion: 1 } } }), '206/256: -2, 50/256: -1');
    });

    it('target evasion at +3 or more: 1/2 -1 more', () => {
      // Gist error: the roll starts at +4; IfStatStageLessThan 10 skips it up to +3 (script.s:1858).
      x(boom({ player: { stages: { evasion: 3 } } }), '206/256: -2, 50/256: -1');
      x(boom({ player: { stages: { evasion: 4 } } }), '103/256: -3, 128/256: -2, 25/256: -1');
    });

    it('80% HP or more and faster: 206/256 -3', () => {
      x(boom({ ai: { speed: FAST } }), '206/256: -3, 50/256: 0');
      x(boom({ ai: { speed: FAST, hp: hp(80) } }), '206/256: -3, 50/256: 0');
      x(boom({ ai: { speed: TIE } }), '206/256: -3, 50/256: 0'); // a tie isn't slower
    });

    it('80% or more and slower: 206/256 -1', () => {
      x(boom(), LIKELY_MINUS_1);
      x(boom({ ai: { hp: hp(80) } }), LIKELY_MINUS_1);
    });

    it('over 50%: 206/256 -1', () => {
      x(boom({ ai: { speed: FAST, hp: hp(79) } }), LIKELY_MINUS_1);
      x(boom({ ai: { hp: hp(51) } }), LIKELY_MINUS_1);
    });

    it('50% or less, over 30%: 1/2 +1', () => {
      x(boom({ ai: { hp: hp(50) } }), HALF_PLUS_1);
      x(boom({ ai: { hp: hp(31) } }), HALF_PLUS_1);
    });

    it('30% or less: 206/256 +1', () => {
      // Gist error: the rows don't exclude each other; at 30% or less the 1/2 +1 roll comes first and the 206/256 +1
      // roll adds to it (script.s:1868–1876).
      x(boom({ ai: { hp: hp(30) } }), '103/256: +2, 128/256: +1, 25/256: 0');
    });

    it('Self-Destruct and Memento take the routine', () => {
      x({ moves: [M.SELF_DESTRUCT], effect: E.HALVE_DEFENSE, ai: { hp: hp(30) } }, '103/256: +2, 128/256: +1, 25/256: 0');
      // Hack: Memento has Explosion's effect; its vanilla one, also routed here (script.s:1728), is on no move.
      x({ moves: [M.MEMENTO], effect: E.HALVE_DEFENSE, ai: { hp: hp(30) } }, '103/256: +2, 128/256: +1, 25/256: 0');
      noHackMove(E.FAINT_AND_ATK_SP_ATK_DOWN_2);
    });
  });

  describe('Healing Wish, Lunar Dance (Expert_HealingWish, script.s:6307)', () => {
    it('every rule (-5 when healthy and faster, 206/256 -1 over 50%, the 1/4 +1 section, 1/2 +1 at 30%): no move has either effect', () => {
      noHackMove(E.FAINT_AND_FULL_HEAL_NEXT_MON, E.FAINT_FULL_RESTORE_NEXT_MON);
      // Hack: Lunar Dance restores half the user's HP (RESTORE_HALF_HP), so Expert_Recovery scores it.
      x({ moves: [M.LUNAR_DANCE], effect: E.RESTORE_HALF_HP }, '-3');
      x({ moves: [M.LUNAR_DANCE], ai: { hp: hp(30) } }, '236/256: +2, 20/256: 0');
      // Hack: 361 is HP Electric, a plain hit with no Expert routine.
      x({ moves: [M.HEALING_WISH], effect: E.HIT, ai: { hp: hp(30) } }, '0');
    });
  });

  describe('Mirror Move (Expert_MirrorMove, script.s:1907)', () => {
    const mirror = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.MIRROR_MOVE], effect: E.COPY_MOVE, ...s });
    const LIKELY_MINUS_1 = '176/256: -1, 80/256: 0'; // IfRandomLessThan 80

    it('faster and the target last used a listed move: 1/2 +2', () => {
      x(mirror({ ai: { speed: FAST }, player: { prevMove: M.TOXIC } }), HALF_PLUS_2);
      x(mirror({ ai: { speed: TIE }, player: { prevMove: M.TOXIC } }), HALF_PLUS_2); // a tie isn't slower
      // The table lists move IDs: the hack's HP Psychic, at vanilla Trick's ID, counts.
      x(mirror({ ai: { speed: FAST }, player: { prevMove: M.TRICK } }), HALF_PLUS_2);
    });

    it('otherwise, the target last used an unlisted move: 176/256 -1', () => {
      x(mirror(), LIKELY_MINUS_1); // no last move
      x(mirror({ player: { prevMove: M.TACKLE } }), LIKELY_MINUS_1);
      x(mirror({ ai: { speed: FAST }, player: { prevMove: M.TACKLE } }), LIKELY_MINUS_1);
      x(mirror({ player: { prevMove: M.TOXIC } }), '0'); // slower, a listed move
    });
  });

  describe('Stat-boosting status moves: attacking stats (Expert_StatusAttackUp, :1978; Expert_StatusSpAttackUp, :2081)', () => {
    const howl = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.HOWL], effect: E.ATK_UP, ...s });
    const plot = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.NASTY_PLOT], effect: E.SP_ATK_UP_2, ...s });

    it('+3 or more: 156/256 -1', () => {
      // Gist error: at +3 or more the 100% HP roll is skipped (script.s:1988–1991, 2091–2094).
      x(howl({ ai: { stages: { attack: 3 } } }), '156/256: -1, 100/256: 0'); // IfRandomLessThan 100
      x(plot({ ai: { stages: { spAttack: 3 } } }), '156/256: -1, 100/256: 0');
      x(howl({ ai: { stages: { attack: 2 } } }), HALF_PLUS_2);
    });

    it('100% HP: 1/2 +2', () => {
      x(howl(), HALF_PLUS_2);
      x({ moves: [M.MEDITATE], effect: E.ATK_UP }, HALF_PLUS_2);
      x({ moves: [M.SHARPEN], effect: E.ATK_UP }, HALF_PLUS_2);
      x({ moves: [M.SWORDS_DANCE], effect: E.ATK_UP_2 }, HALF_PLUS_2);
      x({ moves: [M.GROWTH], effect: E.SP_ATK_UP }, HALF_PLUS_2);
      x({ moves: [M.TAIL_GLOW], effect: E.SP_ATK_UP_2 }, HALF_PLUS_2);
      x(plot(), HALF_PLUS_2);
    });

    it('over 70%: nothing more', () => {
      x(howl({ ai: { hp: hp(99) } }), '0');
      x(howl({ ai: { hp: hp(71) } }), '0');
      x(plot({ ai: { hp: hp(71) } }), '0');
    });

    it('under 40%: -2', () => {
      x(howl({ ai: { hp: hp(39) } }), '-2');
      x(plot({ ai: { hp: hp(39) } }), '-2');
    });

    it('otherwise: 216/256 -2 (Special Attack: 186/256)', () => {
      x(howl({ ai: { hp: hp(70) } }), '216/256: -2, 40/256: 0'); // IfRandomLessThan 40
      x(howl({ ai: { hp: hp(40) } }), '216/256: -2, 40/256: 0');
      // Gist error: Expert_StatusSpAttackUp draws IfRandomLessThan 70, so 186/256 (script.s:2104).
      x(plot({ ai: { hp: hp(70) } }), '186/256: -2, 70/256: 0');
      x({ moves: [M.GROWTH], ai: { hp: hp(40) } }, '186/256: -2, 70/256: 0');
    });
  });

  describe('Stat-boosting status moves: defending stats (Expert_StatusDefenseUp, :2009; Expert_StatusSpDefenseUp, :2112)', () => {
    const harden = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.HARDEN], effect: E.DEF_UP, ...s });
    const amnesia = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.AMNESIA], effect: E.SP_DEF_UP_2, ...s });
    const TWO_ROLLS_MINUS_2 = '38416/65536: -2, 27120/65536: 0'; // (196/256)² -2

    it('+3 or more: 156/256 -1', () => {
      // At 69% HP against a Special last move, the -2 is certain. The 100% HP roll is skipped here too (:2022–2025).
      x(harden({ ai: { stages: { defense: 3 }, hp: hp(69) }, player: { prevMove: M.THUNDERBOLT } }), '156/256: -3, 100/256: -2');
      x(amnesia({ ai: { stages: { spDefense: 3 }, hp: hp(69) }, player: { prevMove: M.TACKLE } }), '156/256: -3, 100/256: -2');
    });

    it('100% HP: 1/2 +2', () => {
      // Then 70% or more: 200/256 ends; else no last move (power 0) gives 196/256 -2.
      x(harden(), '27280/65536: +2, 32768/65536: 0, 5488/65536: -2');
    });

    it('70% or more: 200/256 ends the routine', () => {
      x(harden({ ai: { hp: hp(70) }, player: { prevMove: M.THUNDERBOLT } }), '56/256: -2, 200/256: 0');
      x(harden({ ai: { hp: hp(99) }, player: { prevMove: M.THUNDERBOLT } }), '56/256: -2, 200/256: 0');
    });

    it('under 40%: -2', () => {
      x(harden({ ai: { hp: hp(39) } }), '-2');
      x(amnesia({ ai: { hp: hp(39) } }), '-2');
    });

    it("otherwise, the target's last move a status move: 196/256 -2", () => {
      x(harden({ ai: { hp: hp(69) }, player: { prevMove: M.GROWL } }), '196/256: -2, 60/256: 0'); // IfRandomLessThan 60
      x(harden({ ai: { hp: hp(69) } }), '196/256: -2, 60/256: 0'); // no last move: power 0
      x(amnesia({ ai: { hp: hp(69) }, player: { prevMove: M.GROWL } }), '196/256: -2, 60/256: 0');
    });

    it('otherwise, the class the stat guards (Physical for Defense, Special for Special Defense): 58.6% -2', () => {
      x(harden({ ai: { hp: hp(69) }, player: { prevMove: M.TACKLE } }), TWO_ROLLS_MINUS_2);
      x(amnesia({ ai: { hp: hp(69) }, player: { prevMove: M.THUNDERBOLT } }), TWO_ROLLS_MINUS_2);
    });

    it('otherwise, the other class: -2', () => {
      x(harden({ ai: { hp: hp(69) }, player: { prevMove: M.THUNDERBOLT } }), '-2');
      x(amnesia({ ai: { hp: hp(69) }, player: { prevMove: M.TACKLE } }), '-2');
    });

    it('note: Bulk Up takes the Defense routine; Cosmic Power and Calm Mind the Special Defense one', () => {
      x({ moves: [M.BULK_UP], effect: E.ATK_DEF_UP, ai: { hp: hp(69) }, player: { prevMove: M.THUNDERBOLT } }, '-2');
      x({ moves: [M.BULK_UP], ai: { stages: { defense: 3 }, hp: hp(69) }, player: { prevMove: M.THUNDERBOLT } }, '156/256: -3, 100/256: -2');
      x({ moves: [M.COSMIC_POWER], effect: E.DEF_SPD_UP, ai: { hp: hp(69) }, player: { prevMove: M.TACKLE } }, '-2');
      x({ moves: [M.CALM_MIND], effect: E.SP_ATK_SP_DEF_UP, ai: { hp: hp(69) }, player: { prevMove: M.TACKLE } }, '-2');
      x({ moves: [M.CALM_MIND], ai: { stages: { spDefense: 3 }, hp: hp(69) }, player: { prevMove: M.TACKLE } }, '156/256: -3, 100/256: -2');
      x({ moves: [M.WITHDRAW], effect: E.DEF_UP, ai: { hp: hp(39) } }, '-2');
      x({ moves: [M.IRON_DEFENSE], effect: E.DEF_UP_2, ai: { hp: hp(39) } }, '-2');
      x({ moves: [M.ACID_ARMOR], effect: E.DEF_UP_2, ai: { hp: hp(39) } }, '-2');
      // Hack: Stockpile and Defend Order have Cosmic Power's effect (DEF_SPD_UP).
      x({ moves: [M.STOCKPILE], effect: E.DEF_SPD_UP, ai: { hp: hp(69) }, player: { prevMove: M.TACKLE } }, '-2');
      x({ moves: [M.DEFEND_ORDER], effect: E.DEF_SPD_UP, ai: { hp: hp(69) }, player: { prevMove: M.TACKLE } }, '-2');
      noHackMove(E.SP_DEF_UP); // Hack: no move raises Special Defense by one stage
    });
  });

  describe('Stat-boosting status moves: Speed (Expert_StatusSpeedUp, script.s:2066)', () => {
    it('faster: -3', () => {
      x({ moves: [M.AGILITY], effect: E.SPEED_UP_2, ai: { speed: FAST } }, '-3');
      x({ moves: [M.AGILITY], ai: { speed: TIE } }, '-3'); // a tie isn't slower
    });

    it('slower: 186/256 +3', () => {
      x({ moves: [M.AGILITY] }, '186/256: +3, 70/256: 0'); // IfRandomLessThan 70
      x({ moves: [M.ROCK_POLISH], effect: E.SPEED_UP_2 }, '186/256: +3, 70/256: 0');
      noHackMove(E.SPEED_UP); // Hack: no move raises Speed by one stage
    });
  });

  describe('Stat-boosting status moves: accuracy (Expert_StatusAccuracyUp, script.s:2169)', () => {
    it('+3 or more 206/256 -2; under 70% -2: no move raises accuracy', () => {
      // The script's HP test is IfHPPercentGreaterThan 70 (script.s:2178), so 70% would get the -2 too; but no hack move
      // (and no vanilla move) reaches the routine.
      noHackMove(E.ACC_UP, E.ACC_UP_2);
    });
  });

  describe('Stat-boosting status moves: evasion (Expert_StatusEvasionUp, script.s:2184)', () => {
    const team = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.DOUBLE_TEAM], effect: E.EVA_UP, ...s });
    /** 89% HP: no 90% roll, and over 70% so the HP checks at the end are skipped. */
    const at89 = (s: Partial<GistSetup> = {}): GistSetup => team({ ...s, ai: { hp: hp(89), ...s.ai } });

    it('90% HP or more: 156/256 +3', () => {
      x(team(), '156/256: +3, 100/256: 0');
      x(team({ ai: { hp: hp(90) } }), '156/256: +3, 100/256: 0');
      x(team({ ai: { hp: hp(89) } }), '0');
      x({ moves: [M.MINIMIZE], effect: E.EVA_UP_2_MINIMIZE }, '156/256: +3, 100/256: 0');
      noHackMove(E.EVA_UP_2); // Hack: no move raises evasion by two without Minimize's effect
    });

    it('+3 or more: 1/2 -1', () => {
      x(at89({ ai: { stages: { evasion: 3 } } }), '1/2: -1, 1/2: 0');
      x(at89({ ai: { stages: { evasion: 2 } } }), '0');
    });

    it('target badly poisoned, attacker over 50%: 206/256 +3', () => {
      x(at89({ player: { status: MON_CONDITION_TOXIC } }), '206/256: +3, 50/256: 0');
      x(at89({ player: { status: MON_CONDITION_POISON } }), '0');
    });

    it('target badly poisoned, attacker at 50% or less: 176/256 × 206/256 +3', () => {
      // At 50% the HP checks follow, but a neutral evasion stage ends them (script.s:2245).
      x(team({ ai: { hp: hp(50) }, player: { status: MON_CONDITION_TOXIC } }), '36256/65536: +3, 29280/65536: 0');
    });

    it('target seeded: 186/256 +3', () => {
      x(at89({ player: { moveEffectsMask: MOVE_EFFECT_LEECH_SEED } }), '186/256: +3, 70/256: 0');
    });

    it('attacker under Ingrain or Aqua Ring: 1/2 +2', () => {
      x(at89({ ai: { moveEffectsMask: MOVE_EFFECT_INGRAIN } }), HALF_PLUS_2);
      x(at89({ ai: { moveEffectsMask: MOVE_EFFECT_AQUA_RING } }), HALF_PLUS_2);
      x(at89({ ai: { moveEffectsMask: MOVE_EFFECT_INGRAIN | MOVE_EFFECT_AQUA_RING } }), HALF_PLUS_2); // one roll
    });

    it('target cursed: 186/256 +3', () => {
      x(at89({ player: { statusVolatile: VOLATILE_CONDITION_CURSE } }), '186/256: +3, 70/256: 0');
    });

    it('over 70%: nothing more', () => {
      x(team({ ai: { hp: hp(71), stages: { evasion: 1 } }, player: { hp: hp(39) } }), '0');
    });

    it('70% or less: evasion exactly +0 ends', () => {
      x(team({ ai: { hp: hp(39) } }), '0');
    });

    it('70% or less: either side under 40% -2', () => {
      x(team({ ai: { hp: hp(39), stages: { evasion: 1 } } }), '-2');
      x(team({ ai: { hp: hp(70), stages: { evasion: 1 } }, player: { hp: hp(39) } }), '-2');
    });

    it('70% or less: otherwise 186/256 -2', () => {
      x(team({ ai: { hp: hp(70), stages: { evasion: 1 } } }), '186/256: -2, 70/256: 0');
      x(team({ ai: { hp: hp(40), stages: { evasion: -1 } } }), '186/256: -2, 70/256: 0'); // any stage but +0
    });
  });

  describe('Dragon Dance (Expert_DragonDance, script.s:4765)', () => {
    it('slower: 1/2 +1', () => {
      x({ moves: [M.DRAGON_DANCE], effect: E.ATK_SPD_UP }, HALF_PLUS_1);
    });

    it('50% HP or less: 186/256 -1', () => {
      x({ moves: [M.DRAGON_DANCE], ai: { speed: FAST, hp: hp(50) } }, '186/256: -1, 70/256: 0');
      x({ moves: [M.DRAGON_DANCE], ai: { speed: FAST, hp: hp(51) } }, '0');
      // Gist error: a slower attacker never reaches the HP check (script.s:4769, 4775–4777).
      x({ moves: [M.DRAGON_DANCE], ai: { hp: hp(50) } }, HALF_PLUS_1);
    });
  });

  describe('Acupressure (Expert_Acupressure, script.s:5008)', () => {
    const acu = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ACUPRESSURE], effect: E.RANDOM_STAT_UP_2, ...s });

    it('50% HP or less: -1', () => {
      x(acu({ ai: { hp: hp(50) } }), '-1');
    });

    it('over 90%: 192/256 +1', () => {
      x(acu(), '192/256: +1, 64/256: 0');
      x(acu({ ai: { hp: hp(91) } }), '192/256: +1, 64/256: 0');
    });

    it('otherwise: 96/256 +1', () => {
      x(acu({ ai: { hp: hp(90) } }), '96/256: +1, 160/256: 0');
      x(acu({ ai: { hp: hp(51) } }), '96/256: +1, 160/256: 0');
    });
  });

  describe('Stat-reducing status moves: attacking stats (Expert_StatusAttackDown, script.s:2277)', () => {
    const growl = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.GROWL], effect: E.ATK_DOWN, ...s });

    it('target at any stage but +0: -1', () => {
      x(growl(), '0');
      x(growl({ player: { stages: { attack: -1 } } }), '-1');
      x(growl({ player: { stages: { attack: 1 } } }), '-1');
    });

    it('...and the attacker at 90% or less: -1 more', () => {
      x(growl({ ai: { hp: hp(90) }, player: { stages: { attack: -1 } } }), '-2');
      x(growl({ ai: { hp: hp(91) }, player: { stages: { attack: -1 } } }), '-1');
      x(growl({ ai: { hp: hp(90) } }), '0'); // only with a changed stage
    });

    it('...and the target at -3 or less: 206/256 -2 more', () => {
      x(growl({ player: { stages: { attack: -3 } } }), '206/256: -3, 50/256: -1');
      x(growl({ player: { stages: { attack: -2 } } }), '-1');
    });

    it("the target's HP at 70% or less: -2", () => {
      x(growl({ player: { hp: hp(70) } }), '-2');
      x(growl({ player: { hp: hp(71) } }), '0');
    });

    it("the target's last move not of the stat's class: 1/2 -2", () => {
      x(growl({ player: { prevMove: M.THUNDERBOLT } }), '1/2: -2, 1/2: 0');
      x({ moves: [M.CHARM], effect: E.ATK_DOWN_2, player: { prevMove: M.THUNDERBOLT } }, '1/2: -2, 1/2: 0');
      x({ moves: [M.FEATHER_DANCE], effect: E.ATK_DOWN_2, player: { prevMove: M.THUNDERBOLT } }, '1/2: -2, 1/2: 0');
      x(growl({ player: { prevMove: M.TACKLE } }), '0');
      // Gist error: only a Special last move rolls (IfLoadedNotEqualTo CLASS_SPECIAL, script.s:2302); a status move doesn't.
      x(growl({ player: { prevMove: M.GROWL } }), '0');
    });

    it('hack: no move lowers Special Attack (Expert_StatusSpAttackDown, script.s:2368)', () => {
      noHackMove(E.SP_ATK_DOWN, E.SP_ATK_DOWN_2);
    });
  });

  describe('Stat-reducing status moves: defending stats (Expert_StatusDefenseDown, :2318; Expert_StatusSpDefenseDown, :2411)', () => {
    const leer = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.LEER], effect: E.DEF_DOWN, ...s });
    const LIKELY_MINUS_2 = '206/256: -2, 50/256: 0';

    it("the attacker under 70%: 206/256 -2", () => {
      x(leer(), '0');
      x(leer({ ai: { hp: hp(69) } }), LIKELY_MINUS_2);
      x(leer({ ai: { hp: hp(70) } }), '0');
    });

    it('otherwise, the target at -3 or less: 206/256 -2', () => {
      x(leer({ player: { stages: { defense: -3 } } }), LIKELY_MINUS_2);
      x(leer({ player: { stages: { defense: -2 } } }), '0');
      x(leer({ ai: { hp: hp(69) }, player: { stages: { defense: -3 } } }), LIKELY_MINUS_2); // one roll
    });

    it("the target's HP under 70%: -2", () => {
      // Gist error: 70% exactly gets it too (IfHPPercentGreaterThan 70 skips it, script.s:2332).
      x(leer({ player: { hp: hp(70) } }), '-2');
      x(leer({ player: { hp: hp(71) } }), '0');
      x(leer({ ai: { hp: hp(69) }, player: { hp: hp(70) } }), '206/256: -4, 50/256: -2');
    });

    it('note: Tail Whip, Screech and Tickle take the Defense routine; Kinesis the Special Defense one', () => {
      x({ moves: [M.TAIL_WHIP], effect: E.DEF_DOWN, ai: { hp: hp(69) } }, LIKELY_MINUS_2);
      x({ moves: [M.SCREECH], effect: E.DEF_DOWN_2, player: { hp: hp(70) } }, '-2');
      x({ moves: [M.TICKLE], effect: E.ATK_DEF_DOWN, player: { stages: { defense: -3 } } }, LIKELY_MINUS_2);
      // Hack: Kinesis lowers Special Defense by two (vanilla: accuracy by one).
      x({ moves: [M.KINESIS], effect: E.SP_DEF_DOWN_2, player: { stages: { spDefense: -3 } } }, LIKELY_MINUS_2);
      x({ moves: [M.KINESIS], player: { stages: { defense: -3 } } }, '0');
      x({ moves: [M.KINESIS], player: { hp: hp(70) } }, '-2');
      noHackMove(E.SP_DEF_DOWN); // Hack: no move lowers Special Defense by one stage
    });
  });

  describe('Stat-reducing status moves: Speed (Expert_StatusSpeedDown, script.s:2353)', () => {
    const LIKELY_PLUS_2 = '186/256: +2, 70/256: 0';

    it('slower: 186/256 +2', () => {
      x({ moves: [M.STRING_SHOT], effect: E.SPEED_DOWN }, LIKELY_PLUS_2);
      x({ moves: [M.SCARY_FACE], effect: E.SPEED_DOWN_2 }, LIKELY_PLUS_2);
      x({ moves: [M.COTTON_SPORE], effect: E.SPEED_DOWN_2 }, LIKELY_PLUS_2);
      // Hack: Fake Tears and Metal Sound lower Speed by two (vanilla: Special Defense).
      x({ moves: [M.FAKE_TEARS], effect: E.SPEED_DOWN_2 }, LIKELY_PLUS_2);
      x({ moves: [M.METAL_SOUND], effect: E.SPEED_DOWN_2 }, LIKELY_PLUS_2);
    });

    it('faster: -3', () => {
      x({ moves: [M.STRING_SHOT], ai: { speed: FAST } }, '-3');
      x({ moves: [M.STRING_SHOT], ai: { speed: TIE } }, '-3'); // a tie isn't slower
    });
  });

  describe('Stat-reducing status moves: accuracy (Expert_StatusAccuracyDown, script.s:2431)', () => {
    const sand = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.SAND_ATTACK], effect: E.ACC_DOWN, ...s });
    const LIKELY_MINUS_1 = '156/256: -1, 100/256: 0';
    const LIKELY_PLUS_2 = '186/256: +2, 70/256: 0';

    it("the target at 70% or less and the attacker under 70%: 156/256 -1", () => {
      x(sand(), '0');
      // Gist error: either one is enough (script.s:2449–2454).
      x(sand({ ai: { hp: hp(69) } }), LIKELY_MINUS_1);
      x(sand({ player: { hp: hp(70) } }), LIKELY_MINUS_1);
      x(sand({ ai: { hp: hp(69) }, player: { hp: hp(70) } }), LIKELY_MINUS_1); // one roll
    });

    it('attacker at -2 accuracy or lower: 176/256 -2', () => {
      x(sand({ ai: { stages: { accuracy: -2 } } }), '176/256: -2, 80/256: 0');
      x(sand({ ai: { stages: { accuracy: -1 } } }), '0');
    });

    it('target badly poisoned: 186/256 +2', () => {
      x(sand({ player: { status: MON_CONDITION_TOXIC } }), LIKELY_PLUS_2);
    });

    it('target seeded: 186/256 +2', () => {
      x(sand({ player: { moveEffectsMask: MOVE_EFFECT_LEECH_SEED } }), LIKELY_PLUS_2);
    });

    it('attacker under Ingrain or Aqua Ring: 1/2 +1', () => {
      x(sand({ ai: { moveEffectsMask: MOVE_EFFECT_INGRAIN } }), HALF_PLUS_1);
      x(sand({ ai: { moveEffectsMask: MOVE_EFFECT_AQUA_RING } }), HALF_PLUS_1);
    });

    it('target cursed: 186/256 +2', () => {
      x(sand({ player: { statusVolatile: VOLATILE_CONDITION_CURSE } }), LIKELY_PLUS_2);
    });

    it('attacker over 70%: nothing more', () => {
      x(sand({ ai: { hp: hp(71) }, player: { hp: hp(39), stages: { accuracy: -1 } } }), LIKELY_MINUS_1);
    });

    it("70% or less: the stage at exactly +0 ends", () => {
      // Gist error: the stage is the target's accuracy, not the attacker's (IfStatStageEqualTo AI_BATTLER_DEFENDER,
      // script.s:2489).
      x(sand({ ai: { hp: hp(39) } }), LIKELY_MINUS_1); // the target at +0 ends it, despite our 39%
      x(sand({ ai: { hp: hp(39), stages: { accuracy: 1 } } }), LIKELY_MINUS_1); // our own stage doesn't count
    });

    it('70% or less: either side under 40% -2', () => {
      x(sand({ ai: { hp: hp(39) }, player: { stages: { accuracy: -1 } } }), '156/256: -3, 100/256: -2');
      x(sand({ ai: { hp: hp(69) }, player: { hp: hp(39), stages: { accuracy: -1 } } }), '156/256: -3, 100/256: -2');
    });

    it('70% or less: otherwise 186/256 -2', () => {
      x(sand({ ai: { hp: hp(69) }, player: { stages: { accuracy: -1 } } }),
        '29016/65536: -3, 18600/65536: -2, 10920/65536: -1, 7000/65536: 0');
    });

    it('note: Smoke Screen and Flash take the routine; no move lowers evasion by two (routed here, script.s:1675)', () => {
      x({ moves: [M.SMOKE_SCREEN], effect: E.ACC_DOWN, player: { status: MON_CONDITION_TOXIC } }, LIKELY_PLUS_2);
      x({ moves: [M.FLASH], effect: E.ACC_DOWN, ai: { hp: hp(69) } }, LIKELY_MINUS_1);
      noHackMove(E.EVA_DOWN_2);
    });
  });

  describe('Stat-reducing status moves: evasion (Expert_StatusEvasionDown, script.s:2500)', () => {
    const scent = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.SWEET_SCENT], effect: E.EVA_DOWN, ...s });

    it('the attacker under 70%: 206/256 -2', () => {
      x(scent(), '0');
      x(scent({ ai: { hp: hp(69) } }), '206/256: -2, 50/256: 0');
      x(scent({ ai: { hp: hp(70) } }), '0');
    });

    it('otherwise, the target at -3 or lower: 206/256 -2', () => {
      x(scent({ player: { stages: { evasion: -3 } } }), '206/256: -2, 50/256: 0');
      x(scent({ player: { stages: { evasion: -2 } } }), '0');
    });

    it("the target's HP at 70% or less: -2", () => {
      x(scent({ player: { hp: hp(70) } }), '-2');
      x(scent({ player: { hp: hp(71) } }), '0');
      noHackMove(E.ACC_DOWN_2); // Hack: no move lowers accuracy by two (routed here, script.s:1676)
    });
  });

  describe('Moves ignoring accuracy (Expert_BypassAccuracyMove, script.s:2256)', () => {
    const ace = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.AERIAL_ACE], effect: E.BYPASS_ACCURACY, ...s });

    it('target evasion +5 or more, or attacker accuracy -5 or less: 156/256 +2, else +1', () => {
      x(ace(), '0');
      x(ace({ player: { stages: { evasion: 5 } } }), '156/256: +2, 100/256: +1');
      x(ace({ ai: { stages: { accuracy: -5 } } }), '156/256: +2, 100/256: +1');
    });

    it('target evasion +3 or more, or attacker accuracy -3 or less: +1', () => {
      // Gist error: the +1 is a 156/256 roll (IfRandomLessThan 100, script.s:2263–2272).
      x(ace({ player: { stages: { evasion: 3 } } }), '156/256: +1, 100/256: 0');
      x(ace({ ai: { stages: { accuracy: -3 } } }), '156/256: +1, 100/256: 0');
      x(ace({ player: { stages: { evasion: 2 } } }), '0');
      x(ace({ ai: { stages: { accuracy: -2 } } }), '0');
      x({ moves: [M.SWIFT], effect: E.BYPASS_ACCURACY, player: { stages: { evasion: 3 } } }, '156/256: +1, 100/256: 0');
      x({ moves: [M.SHOCK_WAVE], effect: E.BYPASS_ACCURACY, player: { stages: { evasion: 3 } } }, '156/256: +1, 100/256: 0');
    });
  });

  describe('Vital Throw (Expert_VitalThrow, script.s:2956)', () => {
    it('every rule (slower or over 60%: nothing; under 40%: 206/256 -1; else 76/256 × 206/256 -1): no move has the effect', () => {
      noHackMove(E.PRIORITY_NEG_1_BYPASS_ACCURACY);
      // Hack: Vital Throw has BYPASS_ACCURACY, so it is scored as a move ignoring accuracy.
      x({ moves: [M.VITAL_THROW], effect: E.BYPASS_ACCURACY, ai: { speed: FAST, hp: hp(39) } }, '0');
      x({ moves: [M.VITAL_THROW], player: { stages: { evasion: 3 } } }, '156/256: +1, 100/256: 0');
    });
  });

  describe('Haze (Expert_Haze, script.s:2520)', () => {
    const haze = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.HAZE], effect: E.RESET_STAT_CHANGES, ...s });
    const LIKELY_MINUS_1 = '206/256: -1, 50/256: 0';
    const MINUS_3_THEN_MINUS_1 = '42436/65536: -4, 10300/65536: -3, 10300/65536: -1, 2500/65536: 0';
    const LIKELY_PLUS_3 = '206/256: +3, 50/256: 0';

    it('an attacker stage at +3 or more, or a target stage at -3 or less: 206/256 -3', () => {
      // Then the "otherwise" roll, as nothing encourages it.
      x(haze({ ai: { stages: { attack: 3 } } }), MINUS_3_THEN_MINUS_1);
      x(haze({ ai: { stages: { evasion: 3 } } }), MINUS_3_THEN_MINUS_1);
      x(haze({ player: { stages: { defense: -3 } } }), MINUS_3_THEN_MINUS_1);
      x(haze({ player: { stages: { accuracy: -3 } } }), MINUS_3_THEN_MINUS_1); // the target's accuracy, not its evasion
    });

    it('an attacker stage at -3 or less, or a target stage at +3 or more: 206/256 +3', () => {
      x(haze({ player: { stages: { attack: 3 } } }), LIKELY_PLUS_3);
      x(haze({ player: { stages: { evasion: 3 } } }), LIKELY_PLUS_3);
      x(haze({ ai: { stages: { spDefense: -3 } } }), LIKELY_PLUS_3);
      x(haze({ ai: { stages: { accuracy: -3 } } }), LIKELY_PLUS_3);
      // Both: the -3 roll, then the +3 roll.
      x(haze({ ai: { stages: { attack: 3 } }, player: { stages: { attack: 3 } } }), '10300/65536: +3, 44936/65536: 0, 10300/65536: -3');
    });

    it('otherwise: -1', () => {
      // Gist error: the -1 is a 206/256 roll (IfRandomLessThan 50, script.s:2555–2556), and it follows the -3 roll too.
      x(haze(), LIKELY_MINUS_1);
      x(haze({ ai: { stages: { speed: 3 } } }), LIKELY_MINUS_1); // Speed isn't read
      x(haze({ player: { stages: { attack: 2 } } }), LIKELY_MINUS_1);
    });
  });

  describe('Bide (Expert_Bide, script.s:2566)', () => {
    it('90% HP or less: -2: no move has the effect', () => {
      noHackMove(E.BIDE);
      // Hack: Bide has Metal Burst's effect, so Expert_MetalBurst scores it.
      x({ moves: [M.BIDE], effect: E.METAL_BURST, ai: { hp: hp(90) } }, '64/256: +1, 192/256: 0');
    });
  });

  describe('Switch-forcing moves (Expert_ForceSwitch, script.s:2574)', () => {
    const roar = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ROAR], effect: E.FORCE_SWITCH, ...s });

    it('target in battle for more than 3 turns: 192/256 +2', () => {
      // Gist error: the roll falls through into the 1/2 +2 roll (script.s:2602–2608), so up to +4.
      x(roar({ turn: 4 }), '96/256: +4, 128/256: +2, 32/256: 0');
      x(roar({ turn: 3 }), '-3');
      x(roar({ turn: 4, player: { effects: { fakeOutTurnNumber: 1 } } }), '-3'); // in for 3 turns (LoadBattlerTurnCount)
    });

    it("Spikes, Stealth Rock or Toxic Spikes on the target's side: 1/2 +2", () => {
      x(roar({ sides: [SIDE_CONDITION_SPIKES, 0] }), HALF_PLUS_2);
      x(roar({ sides: [SIDE_CONDITION_STEALTH_ROCK, 0] }), HALF_PLUS_2);
      x(roar({ sides: [SIDE_CONDITION_TOXIC_SPIKES, 0] }), HALF_PLUS_2);
      x(roar({ sides: [0, SIDE_CONDITION_SPIKES] }), '-3'); // our side doesn't count
    });

    it('target at +3 or more in Attack, Defense, Sp. Atk, Sp. Def or evasion: 1/2 +2', () => {
      for (const stat of ['attack', 'defense', 'spAttack', 'spDefense', 'evasion'] as StageName[]) {
        x(roar({ player: { stages: { [stat]: 3 } } }), HALF_PLUS_2);
      }
      x(roar({ player: { stages: { speed: 3 } } }), '-3');
      x(roar({ player: { stages: { attack: 2 } } }), '-3');
    });

    it('otherwise: -3', () => {
      x(roar(), '-3');
      x({ moves: [M.WHIRLWIND], effect: E.FORCE_SWITCH }, '-3');
    });
  });

  describe('Conversion (Expert_Conversion, script.s:2613)', () => {
    it('90% HP or less -2; not the first turn 200/256 -2: no move has the effect', () => {
      noHackMove(E.CONVERSION);
      x({ moves: [M.CONVERSION], effect: E.HIT, ai: { hp: hp(50) }, turn: 1 }, '0'); // Hack: 160 is HP Ice
    });
  });

  describe('Recovery moves (Expert_Recovery, :2640; Expert_Synthesis, :2628)', () => {
    const recover = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.RECOVER], effect: E.RESTORE_HALF_HP, ...s });
    const LIKELY_PLUS_2 = '236/256: +2, 20/256: 0'; // IfRandomLessThan 20

    it('full HP: -3 and end', () => {
      x(recover(), '-3');
      x(recover({ ai: { speed: FAST } }), '-3');
    });

    it('faster: -8 and end', () => {
      x(recover({ ai: { speed: FAST, hp: hp(99) } }), '-8');
      x(recover({ ai: { speed: TIE, hp: hp(50) } }), '-8'); // a tie isn't slower
    });

    it('70% HP or more: 226/256 -3 and end', () => {
      x(recover({ ai: { hp: hp(70) } }), '57856/65536: -3, 7080/65536: +2, 600/65536: 0'); // IfRandomLessThan 30
    });

    it("the target doesn't know Snatch: 236/256 +2", () => {
      x(recover({ ai: { hp: hp(69) } }), LIKELY_PLUS_2);
    });

    it('the target knows Snatch: 156/256 × 236/256 +2 (hack: no move has Snatch\'s effect)', () => {
      noHackMove(E.STEAL_STATUS_MOVE);
      // Hack: Snatch's ID (289) is Drill Run, a high-crit hit, so knowing it changes nothing.
      x(recover({ ai: { hp: hp(69) }, known: { moves: [M.SNATCH] } }), LIKELY_PLUS_2);
    });

    it('sun-boosted recovery (Synthesis, Morning Sun, Moonlight): hail, rain or sand -2 more', () => {
      x({ moves: [M.MORNING_SUN], effect: E.HEAL_HALF_MORE_IN_SUN, ai: { hp: hp(69) } }, LIKELY_PLUS_2);
      x({ moves: [M.MORNING_SUN], ai: { hp: hp(69) }, field: FIELD_CONDITION_RAINING_PERM }, '236/256: 0, 20/256: -2');
      x({ moves: [M.SYNTHESIS], effect: E.HEAL_HALF_MORE_IN_SUN, field: FIELD_CONDITION_SANDSTORM_PERM }, '-5');
      x({ moves: [M.MOONLIGHT], effect: E.HEAL_HALF_MORE_IN_SUN, field: FIELD_CONDITION_HAILING_PERM }, '-5');
      x({ moves: [M.MOONLIGHT], field: FIELD_CONDITION_SUNNY_PERM }, '-3');
      // LoadCurrentWeather tests the fog bit last (trainer_ai.c:1436), so an unknown fog bit can't be read past.
      x({ moves: [M.MORNING_SUN], patch: (v) => { v.unknown = [PATHS.fog]; } }, { throws: 'UNDEFINED' });
    });

    it('note: Softboiled, Roost and (hack) Lunar Dance take the routine; Swallow\'s and the unused effects are on no move', () => {
      x({ moves: [M.SOFTBOILED], effect: E.RESTORE_HALF_HP, ai: { hp: hp(69) } }, LIKELY_PLUS_2);
      x({ moves: [M.ROOST], effect: E.HEAL_HALF_REMOVE_FLYING_TYPE, ai: { speed: FAST, hp: hp(50) } }, '-8');
      x({ moves: [M.LUNAR_DANCE], effect: E.RESTORE_HALF_HP, ai: { hp: hp(69) } }, LIKELY_PLUS_2);
      noHackMove(E.SWALLOW, E.UNUSED_133, E.UNUSED_134, E.UNUSED_157);
    });
  });

  describe('Rest (Expert_Rest, script.s:2745)', () => {
    const rest = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.REST], effect: E.REST, ...s });
    const LIKELY_PLUS_3 = '246/256: +3, 10/256: 0'; // IfRandomLessThan 10

    it('faster at full HP: 60.9% -8 and end', () => {
      // Gist error: a certain -8; there is no roll (script.s:2759–2761).
      x(rest({ ai: { speed: FAST } }), '-8');
    });

    it('faster, over 50%: -3 and end', () => {
      x(rest({ ai: { speed: FAST, hp: hp(51) } }), '-3');
    });

    it('faster, 40% or more: 186/256 -3 and end', () => {
      x(rest({ ai: { speed: FAST, hp: hp(50) } }), '47616/65536: -3, 17220/65536: +3, 700/65536: 0');
      x(rest({ ai: { speed: FAST, hp: hp(40) } }), '47616/65536: -3, 17220/65536: +3, 700/65536: 0');
    });

    it('slower, over 70%: -3 and end', () => {
      x(rest(), '-3');
      x(rest({ ai: { hp: hp(71) } }), '-3');
    });

    it('slower, 60% or more: 206/256 -3 and end', () => {
      x(rest({ ai: { hp: hp(70) } }), '52736/65536: -3, 12300/65536: +3, 500/65536: 0');
      x(rest({ ai: { hp: hp(60) } }), '52736/65536: -3, 12300/65536: +3, 500/65536: 0');
    });

    it("the target doesn't know Snatch: 246/256 +3", () => {
      x(rest({ ai: { hp: hp(59) } }), LIKELY_PLUS_3);
      x(rest({ ai: { speed: FAST, hp: hp(39) } }), LIKELY_PLUS_3);
    });

    it("the target knows Snatch: 206/256 × 246/256 +3 (hack: no move has Snatch's effect)", () => {
      noHackMove(E.STEAL_STATUS_MOVE);
      x(rest({ ai: { hp: hp(59) }, known: { moves: [M.SNATCH] } }), LIKELY_PLUS_3);
    });
  });

  describe('Toxic, Leech Seed (Expert_ToxicLeechSeed, script.s:2680)', () => {
    const LIKELY_MINUS_3 = '206/256: -3, 50/256: 0';

    it("with a damaging move: the attacker at 50% or less, 206/256 -3", () => {
      x({ moves: [M.TOXIC, M.TACKLE], effect: E.STATUS_BADLY_POISON }, '0');
      x({ moves: [M.TOXIC, M.TACKLE], ai: { hp: hp(50) } }, LIKELY_MINUS_3);
      x({ moves: [M.TOXIC, M.TACKLE], ai: { hp: hp(51) } }, '0');
      x({ moves: [M.TOXIC], ai: { hp: hp(50) } }, '0'); // no damaging move
    });

    it('with a damaging move: the target at 50% or less, 206/256 -3', () => {
      x({ moves: [M.TOXIC, M.TACKLE], player: { hp: hp(50) } }, LIKELY_MINUS_3);
      x({ moves: [M.LEECH_SEED, M.TACKLE], effect: E.STATUS_LEECH_SEED, player: { hp: hp(50) } }, LIKELY_MINUS_3);
      x({ moves: [M.TOXIC, M.TACKLE], ai: { hp: hp(50) }, player: { hp: hp(50) } }, '42436/65536: -6, 20600/65536: -3, 2500/65536: 0');
      x({ moves: [M.TOXIC], player: { hp: hp(50) } }, '0');
    });

    it('knows a +1 Special Defense move or a Protect move: 196/256 +2', () => {
      x({ moves: [M.TOXIC, M.PROTECT] }, '196/256: +2, 60/256: 0'); // IfRandomLessThan 60
      x({ moves: [M.LEECH_SEED, M.DETECT] }, '196/256: +2, 60/256: 0');
      // Hack: Poison Gas has Toxic's effect.
      x({ moves: [M.POISON_GAS, M.PROTECT], effect: E.STATUS_BADLY_POISON }, '196/256: +2, 60/256: 0');
      noHackMove(E.SP_DEF_UP);
    });
  });

  describe('Light Screen (Expert_LightScreen, script.s:2710)', () => {
    const screen = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.LIGHT_SCREEN], effect: E.SET_LIGHT_SCREEN, ...s });

    it('under 50% HP: -2', () => {
      x(screen({ ai: { hp: hp(49) } }), '-2');
      x(screen({ ai: { hp: hp(49) }, player: { prevMove: M.THUNDERBOLT } }), '-2'); // and the routine ends (script.s:2728–2731)
    });

    it('90% or more: 1/2 +1', () => {
      x(screen(), HALF_PLUS_1);
      x(screen({ ai: { hp: hp(90) } }), HALF_PLUS_1);
      x(screen({ ai: { hp: hp(89) } }), '0');
    });

    it("the target's last move Special: 192/256 +1", () => {
      x(screen({ ai: { hp: hp(89) }, player: { prevMove: M.THUNDERBOLT } }), '192/256: +1, 64/256: 0');
      x(screen({ player: { prevMove: M.THUNDERBOLT } }), '96/256: +2, 128/256: +1, 32/256: 0');
      x(screen({ ai: { hp: hp(89) }, player: { prevMove: M.TACKLE } }), '0');
    });
  });

  describe('Reflect (Expert_Reflect, script.s:2893)', () => {
    const reflect = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.REFLECT], effect: E.SET_REFLECT, ...s });

    it('under 50% HP: -2', () => {
      x(reflect({ ai: { hp: hp(49) } }), '-2');
      x(reflect({ ai: { hp: hp(49) }, player: { prevMove: M.TACKLE } }), '-2');
    });

    it('90% or more: 1/2 +1', () => {
      x(reflect({ player: { prevMove: M.THUNDERBOLT } }), HALF_PLUS_1);
      x(reflect({ ai: { hp: hp(89) }, player: { prevMove: M.THUNDERBOLT } }), '0');
    });

    it("the target's last move Physical: 192/256 +1", () => {
      x(reflect({ ai: { hp: hp(89) }, player: { prevMove: M.TACKLE } }), '192/256: +1, 64/256: 0');
      x(reflect({ ai: { hp: hp(89) }, player: { prevMove: M.GROWL } }), '0');
      // No last move: MOVE_NONE's record has class Physical, so a target that hasn't moved counts.
      x(reflect({ ai: { hp: hp(89) } }), '192/256: +1, 64/256: 0');
      x(reflect(), '96/256: +2, 128/256: +1, 32/256: 0');
    });
  });

  describe('OHKO moves (Expert_OHKOMove, script.s:2792)', () => {
    it('64/256 +1', () => {
      x({ moves: [M.GUILLOTINE], effect: E.ONE_HIT_KO }, '64/256: +1, 192/256: 0'); // IfRandomLessThan 192
      x({ moves: [M.HORN_DRILL], effect: E.ONE_HIT_KO }, '64/256: +1, 192/256: 0');
      x({ moves: [M.FISSURE], effect: E.ONE_HIT_KO }, '64/256: +1, 192/256: 0');
    });
  });

  describe('Charge-turn moves without invulnerability (Expert_ChargeTurnNoInvuln, script.s:3933)', () => {
    const wind = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.RAZOR_WIND], effect: E.CHARGE_TURN_HIGH_CRIT, ...s });

    it('resisted or immune: -2 and end', () => {
      x(wind(), '0');
      x(wind({ player: { types: [TYPE_ROCK, TYPE_ROCK] } }), '-2');
      x(wind({ player: { types: ghost } }), '-2');
      x(wind({ player: { types: [TYPE_ROCK, TYPE_ROCK] }, ai: { item: I.POWER_HERB } }), '-2');
    });

    it('skips its charge turn in sun, and the sun is up: +2', () => {
      x({ moves: [M.SOLAR_BEAM], effect: E.SKIP_CHARGE_TURN_IN_SUN, field: FIELD_CONDITION_SUNNY_PERM }, '+2');
      x({ moves: [M.SOLAR_BEAM], field: FIELD_CONDITION_SUNNY_PERM, ai: { item: I.POWER_HERB } }, '+2'); // and the routine ends
      x({ moves: [M.SOLAR_BEAM], field: FIELD_CONDITION_RAINING_PERM }, '0');
      x(wind({ field: FIELD_CONDITION_SUNNY_PERM }), '0');
    });

    it('holds a Power Herb: +2', () => {
      x(wind({ ai: { item: I.POWER_HERB } }), '+2');
      // ...and the routine ends: a known Protect or low HP doesn't follow (script.s:3959–3961).
      x(wind({ ai: { item: I.POWER_HERB, hp: hp(38) }, known: { moves: [M.PROTECT] } }), '+2');
    });

    it('the target knows Protect: -2', () => {
      x(wind({ known: { moves: [M.PROTECT] } }), '-2');
      x(wind({ known: { moves: [M.DETECT] } }), '-2'); // any move with Protect's effect
      x(wind({ known: { moves: [M.PROTECT] }, ai: { hp: hp(38) } }), '-2'); // and the routine ends
    });

    it('38% HP or less: -1', () => {
      x(wind({ ai: { hp: hp(38) } }), '-1');
      x(wind({ ai: { hp: hp(39) } }), '0');
    });

    it('hack: no move has the other charge-turn effects routed here', () => {
      noHackMove(E.CHARGE_TURN_HIGH_CRIT_FLINCH, E.CHARGE_TURN_DEF_UP);
      // Skull Bash's ID (130) is a plain hit; Sky Attack is a recoil move (RECOIL_PARALYZE_HIT).
      x({ moves: [M.SKULL_BASH], effect: E.HIT, ai: { item: I.POWER_HERB } }, '0');
      x({ moves: [M.SKY_ATTACK], effect: E.RECOIL_PARALYZE_HIT, ai: { item: I.POWER_HERB } }, '0');
    });
  });

  describe('Charge-turn moves with invulnerability (Expert_ChargeTurnWithInvuln, :3992; Expert_ShadowForce, :4014)', () => {
    const fly = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.FLY], effect: E.FLY, ...s });
    const LIKELY_PLUS_1 = '176/256: +1, 80/256: 0'; // IfRandomLessThan 80

    it('holds a Power Herb: +2', () => {
      x(fly({ ai: { item: I.POWER_HERB } }), '+2');
      x(fly({ ai: { item: I.POWER_HERB }, known: { moves: [M.PROTECT] } }), '+2'); // and the routine ends
    });

    it('the target knows a Protect move: -1', () => {
      x(fly({ known: { moves: [M.DETECT] } }), '-1');
      x(fly({ known: { moves: [M.PROTECT] }, player: { types: [TYPE_ROCK, TYPE_ROCK] } }), '-1'); // and the routine ends
    });

    it('resisted or immune: +1', () => {
      x(fly(), '0');
      x(fly({ player: { types: [TYPE_ROCK, TYPE_ROCK] } }), '+1');
      x(fly({ player: { types: [TYPE_ELECTRIC, TYPE_STEEL] } }), '+1');
    });

    it('target badly poisoned, cursed or seeded: +1', () => {
      // Gist error: a 176/256 roll (IfRandomLessThan 80, script.s:4028–4030, 4057–4059), not a certain +1.
      x(fly({ player: { status: MON_CONDITION_TOXIC } }), LIKELY_PLUS_1);
      x(fly({ player: { statusVolatile: VOLATILE_CONDITION_CURSE } }), LIKELY_PLUS_1);
      x(fly({ player: { moveEffectsMask: MOVE_EFFECT_LEECH_SEED } }), LIKELY_PLUS_1);
      x(fly({ player: { status: MON_CONDITION_POISON } }), '0');
    });

    it('sand or hail, and a type immune to its damage: 176/256 +1', () => {
      x(fly({ field: FIELD_CONDITION_SANDSTORM_PERM, ai: { types: [TYPE_ROCK, TYPE_ROCK] } }), LIKELY_PLUS_1);
      x(fly({ field: FIELD_CONDITION_SANDSTORM_PERM, ai: { types: [TYPE_NORMAL, TYPE_STEEL] } }), LIKELY_PLUS_1);
      x(fly({ field: FIELD_CONDITION_SANDSTORM_PERM, ai: { types: [TYPE_GROUND, TYPE_GROUND] } }), LIKELY_PLUS_1);
      x(fly({ field: FIELD_CONDITION_HAILING_PERM, ai: { types: [TYPE_ICE, TYPE_ICE] } }), LIKELY_PLUS_1);
      x(fly({ field: FIELD_CONDITION_SANDSTORM_PERM }), '0');
      x(fly({ field: FIELD_CONDITION_HAILING_PERM, ai: { types: [TYPE_ROCK, TYPE_ROCK] } }), '0');
    });

    it("faster, and the target's last move not an always-hit effect: 176/256 +1", () => {
      x(fly({ ai: { speed: FAST } }), LIKELY_PLUS_1); // no last move: effect HIT
      x(fly({ ai: { speed: FAST }, player: { prevMove: M.LOCK_ON } }), '0');
      x(fly({ ai: { speed: FAST }, player: { prevMove: M.MIND_READER } }), '0');
      // Gist error: the always-hit effect is Lock-On's and Mind Reader's NEXT_ATTACK_ALWAYS_HITS (script.s:4054), not
      // Aerial Ace's BYPASS_ACCURACY, which still gets the roll.
      x(fly({ ai: { speed: FAST }, player: { prevMove: M.AERIAL_ACE } }), LIKELY_PLUS_1);
    });

    it('Shadow Force: Power Herb only +1, and no Protect check', () => {
      const force = (s: Partial<GistSetup> = {}): GistSetup => ({
        moves: [M.SHADOW_FORCE], effect: E.SHADOW_FORCE, ...s, player: { types: psychic, ...s.player },
      });
      x(force(), '0');
      x(force({ ai: { item: I.POWER_HERB } }), '+1');
      x(force({ known: { moves: [M.PROTECT] } }), '0');
      x(force({ player: { status: MON_CONDITION_TOXIC } }), LIKELY_PLUS_1);
      x({ moves: [M.SHADOW_FORCE] }, '+1'); // Ghost into a Normal type: immune, +1
    });

    it('hack: Dig, Dive and Bounce are plain hits', () => {
      noHackMove(E.DIG, E.DIVE, E.BOUNCE);
      x({ moves: [M.DIG], effect: E.HIT, ai: { item: I.POWER_HERB } }, '0');
      x({ moves: [M.DIVE], effect: E.HIT, ai: { item: I.POWER_HERB } }, '0');
      x({ moves: [M.BOUNCE], effect: E.PARALYZE_HIT, ai: { item: I.POWER_HERB } }, '0');
    });
  });

  describe('Fake Out (Expert_FakeOut, script.s:4074)', () => {
    it('+2', () => {
      x({ moves: [M.FAKE_OUT], effect: E.ALWAYS_FLINCH_FIRST_TURN_ONLY }, '+2');
      x({ moves: [M.FAKE_OUT], turn: 3 }, '+2');
    });
  });

  describe('Spit Up (Expert_SpitUp, script.s:4079)', () => {
    it('Stockpile at 2 or more: 176/256 +2: no move has the effect', () => {
      noHackMove(E.SPIT_UP);
      x({ moves: [M.SPIT_UP], effect: E.HIT, ai: { effects: { stockpileCount: 2 } } }, '0'); // Hack: 255 is HP Rock
    });
  });

  describe('Super Fang (Expert_SuperFang, script.s:2800)', () => {
    it("the target at 50% HP or less: -1", () => {
      x({ moves: [M.SUPER_FANG], effect: E.HALVE_HP }, '0');
      x({ moves: [M.SUPER_FANG], player: { hp: hp(51) } }, '0');
      x({ moves: [M.SUPER_FANG], player: { hp: hp(50) } }, '-1');
    });
  });

  describe('Binding moves (Expert_BindingMove, script.s:2808)', () => {
    const look = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.MEAN_LOOK], effect: E.PREVENT_ESCAPE, ...s });

    it('target badly poisoned, cursed, under Perish Song or infatuated: 1/2 +1', () => {
      // Hack: no move has BIND_HIT; Wrap, Clamp and the other binding moves have Whirlpool's effect, which Expert doesn't
      // route. Mean Look, Block and Spider Web (PREVENT_ESCAPE, script.s:1698) take the routine.
      noHackMove(E.BIND_HIT);
      x({ moves: [M.WRAP], effect: E.WHIRLPOOL, player: { status: MON_CONDITION_TOXIC } }, '0');
      x({ moves: [M.CLAMP], effect: E.WHIRLPOOL, player: { status: MON_CONDITION_TOXIC } }, '0');
      x(look(), '0');
      x(look({ player: { status: MON_CONDITION_TOXIC } }), HALF_PLUS_1);
      x(look({ player: { statusVolatile: VOLATILE_CONDITION_CURSE } }), HALF_PLUS_1);
      x(look({ player: { moveEffectsMask: MOVE_EFFECT_PERISH_SONG } }), HALF_PLUS_1);
      x(look({ player: { statusVolatile: VOLATILE_CONDITION_ATTRACT_0 } }), HALF_PLUS_1);
      x(look({ player: { status: MON_CONDITION_POISON } }), '0');
      x({ moves: [M.BLOCK], effect: E.PREVENT_ESCAPE, player: { status: MON_CONDITION_TOXIC } }, HALF_PLUS_1);
      x({ moves: [M.SPIDER_WEB], effect: E.PREVENT_ESCAPE, player: { status: MON_CONDITION_TOXIC } }, HALF_PLUS_1);
    });
  });

  describe('High critical-hit ratio (Expert_HighCritical, script.s:2827)', () => {
    const ONE_IN_4 = '64/256: +1, 192/256: 0';

    it('super effective: 1/2 +1', () => {
      x({ moves: [M.KARATE_CHOP], effect: E.HIGH_CRITICAL }, HALF_PLUS_1); // Fighting into Normal
      x({ moves: [M.KARATE_CHOP], player: { types: [TYPE_NORMAL, TYPE_ICE] } }, HALF_PLUS_1); // quadruple
      x({ moves: [M.KARATE_CHOP], ai: { types: [TYPE_FIGHTING, TYPE_FIGHTING] } }, HALF_PLUS_1); // with STAB
      x({ moves: [M.BLAZE_KICK], effect: E.HIGH_CRITICAL_BURN_HIT, player: { types: [TYPE_GRASS, TYPE_GRASS] } }, HALF_PLUS_1);
      x({ moves: [M.CROSS_POISON], effect: E.HIGH_CRITICAL_POISON_HIT, player: { types: [TYPE_GRASS, TYPE_GRASS] } }, HALF_PLUS_1);
    });

    it('neutral: 1/4 +1', () => {
      x({ moves: [M.SLASH], effect: E.HIGH_CRITICAL }, ONE_IN_4); // with STAB
      x({ moves: [M.SLASH], ai: { types: [TYPE_FIRE, TYPE_FIRE] } }, ONE_IN_4);
      x({ moves: [M.POISON_TAIL], effect: E.HIGH_CRITICAL_POISON_HIT }, ONE_IN_4);
      // Hack: Snatch's and Heal Block's IDs are Drill Run and Aqua Cutter, high-crit hits.
      x({ moves: [M.SNATCH], effect: E.HIGH_CRITICAL }, ONE_IN_4);
      x({ moves: [M.HEAL_BLOCK], effect: E.HIGH_CRITICAL }, ONE_IN_4);
      // Resisted or immune: nothing.
      x({ moves: [M.SLASH], player: { types: [TYPE_ROCK, TYPE_ROCK] } }, '0');
      x({ moves: [M.SLASH], player: { types: ghost } }, '0');
    });
  });

  describe('Recoil moves (Expert_RecoilMove, script.s:6289)', () => {
    const rockHead = { ability: A.ROCK_HEAD };

    it('resisted or immune: nothing more', () => {
      x({ moves: [M.DOUBLE_EDGE], effect: E.RECOIL_THIRD, ai: rockHead, player: { types: [TYPE_ROCK, TYPE_ROCK] } }, '0');
      x({ moves: [M.DOUBLE_EDGE], ai: rockHead, player: { types: ghost } }, '0');
    });

    it('Rock Head or Magic Guard: +1', () => {
      x({ moves: [M.DOUBLE_EDGE], effect: E.RECOIL_THIRD }, '0');
      x({ moves: [M.DOUBLE_EDGE], ai: rockHead }, '+1');
      x({ moves: [M.DOUBLE_EDGE], ai: { ability: A.MAGIC_GUARD } }, '+1');
      x({ moves: [M.FLARE_BLITZ], effect: E.RECOIL_BURN_HIT, ai: rockHead }, '+1');
      x({ moves: [M.VOLT_TACKLE], effect: E.RECOIL_PARALYZE_HIT, ai: rockHead }, '+1');
      x({ moves: [M.HEAD_SMASH], effect: E.RECOIL_HALF, ai: rockHead }, '+1');
      // Hack: effect 48 (vanilla Take Down's RECOIL_QUARTER) is on Hyper Beam, Giga Impact, Outrage, Superpower, Hydro
      // Cannon and Draco Meteor (docs/ai-changes.md); Eruption, Blast Burn and Overheat have RECOIL_BURN_HIT, Sky Attack
      // RECOIL_PARALYZE_HIT.
      x({ moves: [M.HYPER_BEAM], effect: E.RECOIL_QUARTER, ai: rockHead }, '+1');
      x({ moves: [M.GIGA_IMPACT], effect: E.RECOIL_QUARTER, ai: rockHead }, '+1');
      x({ moves: [M.OUTRAGE], effect: E.RECOIL_QUARTER, ai: rockHead }, '+1');
      x({ moves: [M.SUPERPOWER], effect: E.RECOIL_QUARTER, ai: rockHead }, '+1');
      x({ moves: [M.DRACO_METEOR], effect: E.RECOIL_QUARTER, ai: rockHead }, '+1');
      x({ moves: [M.ERUPTION], effect: E.RECOIL_BURN_HIT, ai: rockHead }, '+1');
      x({ moves: [M.OVERHEAT], effect: E.RECOIL_BURN_HIT, ai: rockHead }, '+1');
      x({ moves: [M.SKY_ATTACK], effect: E.RECOIL_PARALYZE_HIT, ai: rockHead }, '+1');
    });
  });

  describe('Speed-lowering attacks (Expert_SpeedDownOnHit, script.s:2338)', () => {
    it('resisted or immune: nothing more', () => {
      x({ moves: [M.ICY_WIND], effect: E.LOWER_SPEED_HIT, player: { types: [TYPE_WATER, TYPE_WATER] } }, '0');
      x({ moves: [M.MUD_SHOT], effect: E.LOWER_SPEED_HIT, player: { types: [TYPE_FLYING, TYPE_FLYING] } }, '0');
      x({ moves: [M.ROCK_TOMB], effect: E.LOWER_SPEED_HIT, player: { types: [TYPE_STEEL, TYPE_STEEL] } }, '0');
    });

    it('Icy Wind, Rock Tomb and Mud Shot: as Speed-lowering status moves', () => {
      x({ moves: [M.ICY_WIND] }, '186/256: +2, 70/256: 0');
      x({ moves: [M.ROCK_TOMB] }, '186/256: +2, 70/256: 0');
      x({ moves: [M.MUD_SHOT] }, '186/256: +2, 70/256: 0');
      x({ moves: [M.ICY_WIND], ai: { speed: FAST } }, '-3');
      // Other moves with the effect: nothing.
      x({ moves: [M.BUBBLE], effect: E.LOWER_SPEED_HIT }, '0');
      x({ moves: [M.BUBBLE_BEAM], effect: E.LOWER_SPEED_HIT, ai: { speed: FAST } }, '0');
      // Hack: Bulldoze, at vanilla Magnitude's ID (222), has this effect and isn't one of the three.
      x({ moves: [M.MAGNITUDE], effect: E.LOWER_SPEED_HIT, ai: { speed: FAST } }, '0');
    });
  });

  describe('Recharge-turn attacks (Expert_RechargeTurn, script.s:3044)', () => {
    it('every rule (resisted -1, Truant 176/256 +1, the two HP-and-speed -1s): no move has the effect', () => {
      noHackMove(E.RECHARGE_AFTER);
      // Hack: Hyper Beam and Giga Impact are recoil moves (effect 48), so Truant or low HP changes nothing.
      x({ moves: [M.HYPER_BEAM], effect: E.RECOIL_QUARTER, ai: { ability: A.TRUANT } }, '0');
      x({ moves: [M.GIGA_IMPACT], effect: E.RECOIL_QUARTER, ai: { speed: FAST, hp: hp(50) } }, '0');
    });
  });

  describe('Disable (Expert_Disable, script.s:3075)', () => {
    const disable = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.DISABLE], effect: E.DISABLE, ...s });

    it('slower: nothing', () => {
      x(disable({ player: { prevMove: M.TACKLE } }), '0');
      x(disable({ player: { prevMove: M.GROWL } }), '0');
    });

    it("faster, the target's last move a status move: 156/256 -1", () => {
      x(disable({ ai: { speed: FAST }, player: { prevMove: M.GROWL } }), '156/256: -1, 100/256: 0');
      x(disable({ ai: { speed: FAST } }), '156/256: -1, 100/256: 0'); // no last move: power 0
    });

    it('faster, a damaging last move: +1', () => {
      x(disable({ ai: { speed: FAST }, player: { prevMove: M.TACKLE } }), '+1');
      x(disable({ ai: { speed: TIE }, player: { prevMove: M.TACKLE } }), '+1'); // a tie isn't slower
    });
  });

  describe('Encore (Expert_Encore, script.s:3177)', () => {
    const encore = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ENCORE], effect: E.ENCORE, ...s });
    const LIKELY_PLUS_3 = '226/256: +3, 30/256: 0'; // IfRandomLessThan 30

    it('the target is disabled: 226/256 +3', () => {
      x(encore({ player: { effects: { disabledTurns: 2 } } }), LIKELY_PLUS_3);
    });

    it('slower: -2', () => {
      x(encore({ player: { prevMove: M.SWORDS_DANCE } }), '-2');
    });

    it("the target's last move not one of the listed effects: -2", () => {
      x(encore({ ai: { speed: FAST }, player: { prevMove: M.TACKLE } }), '-2');
      x(encore({ ai: { speed: FAST }, player: { prevMove: M.GROWL } }), '-2'); // ATK_DOWN isn't listed
      x(encore({ ai: { speed: FAST } }), '-2'); // no last move: effect HIT
    });

    it('otherwise: 226/256 +3', () => {
      x(encore({ ai: { speed: FAST }, player: { prevMove: M.SWORDS_DANCE } }), LIKELY_PLUS_3);
      x(encore({ ai: { speed: FAST }, player: { prevMove: M.TOXIC } }), LIKELY_PLUS_3);
      // Hack: Thief has DO_NOTHING (vanilla Splash's effect), which the table lists (script.s:3220).
      x(encore({ ai: { speed: FAST }, player: { prevMove: M.THIEF } }), LIKELY_PLUS_3);
    });
  });

  describe('Counter, Mirror Coat (Expert_Counter, :3095; Expert_MirrorCoat, :3852)', () => {
    const counter = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.COUNTER], effect: E.COUNTER, ...s });
    const coat = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.MIRROR_COAT], effect: E.MIRROR_COAT, ...s });
    const LIKELY_PLUS_1 = '156/256: +1, 100/256: 0';
    const LIKELY_PLUS_4 = '156/256: +4, 100/256: 0';
    const LESS_LIKELY_PLUS_4 = '32136/65536: +4, 33400/65536: 0'; // 206/256 × 156/256

    it('the target asleep, confused or infatuated: -1 and end', () => {
      x(counter({ player: { status: ASLEEP } }), '-1');
      x(counter({ player: { statusVolatile: VOLATILE_CONDITION_CONFUSION_0 } }), '-1');
      x(counter({ player: { statusVolatile: VOLATILE_CONDITION_ATTRACT_0 }, ai: { hp: hp(30) } }), '-1');
      x(coat({ player: { status: ASLEEP } }), '-1');
    });

    it('30% HP or less: 246/256 -1', () => {
      // and the 50% roll after it; a Normal target with no last move gets nothing more
      x(counter({ ai: { hp: hp(30) } }), '38376/65536: -2, 26160/65536: -1, 1000/65536: 0');
    });

    it('50% or less: 156/256 -1', () => {
      x(counter({ ai: { hp: hp(50) } }), '156/256: -1, 100/256: 0');
      x(counter({ ai: { hp: hp(51) } }), '0');
    });

    it('knows both Counter and Mirror Coat: 156/256 +4', () => {
      x(counter({ moves: [M.COUNTER, M.MIRROR_COAT], player: { prevMove: M.THUNDERBOLT } }), LIKELY_PLUS_4);
      x(coat({ moves: [M.MIRROR_COAT, M.COUNTER], player: { prevMove: M.TACKLE } }), LIKELY_PLUS_4);
    });

    it("a status last move: the target taunted, 156/256 +1", () => {
      x(counter({ player: { prevMove: M.GROWL, effects: { tauntedTurns: 2 } } }), LIKELY_PLUS_1); // a Normal target: no +4
      x(counter({ player: { effects: { tauntedTurns: 2 } } }), LIKELY_PLUS_1); // no last move: power 0
    });

    it("a status last move: the target of no type in the move's table, 206/256 × 156/256 +4", () => {
      x(counter(), '0'); // Normal is a "physical" type
      x(counter({ player: { types: psychic } }), LESS_LIKELY_PLUS_4);
      x(coat(), LESS_LIKELY_PLUS_4); // Normal isn't a "special" type
      x(coat({ player: { types: [TYPE_NORMAL, TYPE_FIRE] } }), '0');
    });

    it('a damaging last move: the target taunted, 156/256 +1', () => {
      x(counter({ player: { prevMove: M.TACKLE, effects: { tauntedTurns: 2 } } }), '24336/65536: +2, 31200/65536: +1, 10000/65536: 0');
    });

    it("a damaging last move not of the move's class: -1", () => {
      x(counter({ player: { prevMove: M.THUNDERBOLT } }), '-1');
      x(coat({ player: { prevMove: M.TACKLE } }), '-1');
    });

    it("a damaging last move of the move's class: 156/256 +1", () => {
      x(counter({ player: { prevMove: M.TACKLE } }), LIKELY_PLUS_1);
      x(coat({ player: { prevMove: M.THUNDERBOLT } }), LIKELY_PLUS_1);
    });
  });

  describe('Metal Burst (Expert_MetalBurst, script.s:5029)', () => {
    const burst = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.METAL_BURST], effect: E.METAL_BURST, ...s });
    const QUARTER_PLUS_1 = '64/256: +1, 192/256: 0'; // IfRandomLessThan 192

    it('the target asleep, infatuated or confused, or knowing Avalanche/Revenge, Focus Punch or Vital Throw effects: -1 and end', () => {
      x(burst({ player: { status: ASLEEP } }), '-1');
      x(burst({ player: { statusVolatile: VOLATILE_CONDITION_ATTRACT_0 } }), '-1');
      x(burst({ player: { statusVolatile: VOLATILE_CONDITION_CONFUSION_0 } }), '-1');
      x(burst({ known: { moves: [M.FOCUS_PUNCH] } }), '-1');
      // Hack: no move has Revenge's or Vital Throw's vanilla effect; the hack's Revenge, Avalanche and Vital Throw count
      // for nothing.
      noHackMove(E.DOUBLE_POWER_IF_HIT, E.PRIORITY_NEG_1_BYPASS_ACCURACY);
      x(burst({ known: { moves: [M.REVENGE, M.AVALANCHE, M.VITAL_THROW] } }), QUARTER_PLUS_1);
    });

    it('30% HP or less: 246/256 -1', () => {
      // with the 50% roll and the 1/4 +1 roll after it
      x(burst({ ai: { hp: hp(30) } }), '7368192/16777216: -2, 7478784/16777216: -1, 1866240/16777216: 0, 64000/16777216: +1');
    });

    it('50% or less: 156/256 -1', () => {
      x(burst({ ai: { hp: hp(50) } }), '29952/65536: -1, 29184/65536: 0, 6400/65536: +1');
    });

    it('over 50%: 64/256 +1', () => {
      x(burst(), QUARTER_PLUS_1);
      // Gist error: the roll isn't tied to the HP; it runs at any HP (script.s:5061–5063), as the 50% case above shows.
    });

    it("a damaging last move and the target not taunted: 156/256 +1", () => {
      // Gist error: the roll runs when the target IS taunted (IfTargetIsNotTaunted skips it, script.s:5069–5071).
      x(burst({ player: { prevMove: M.TACKLE } }), QUARTER_PLUS_1);
      x(burst({ player: { prevMove: M.TACKLE, effects: { tauntedTurns: 2 } } }),
        '1557504/16777216: +3, 6669312/16777216: +2, 6630400/16777216: +1, 1920000/16777216: 0');
    });

    it('the target not taunted: 156/256 +1', () => {
      // Gist error: again only a taunted target (script.s:5074–5076).
      x(burst({ player: { effects: { tauntedTurns: 2 } } }), '9984/65536: +2, 36352/65536: +1, 19200/65536: 0');
    });
  });

  describe('Pain Split (Expert_PainSplit, script.s:3287)', () => {
    const split = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.PAIN_SPLIT], effect: E.AVERAGE_HP, ...s });

    it("the target under 80%: -1", () => {
      x(split({ player: { hp: hp(79) }, ai: { hp: hp(10) } }), '-1');
    });

    it('slower: over 60% -1, else +1', () => {
      x(split(), '-1');
      x(split({ ai: { hp: hp(61) } }), '-1');
      x(split({ ai: { hp: hp(60) } }), '+1');
    });

    it('faster: over 40% -1', () => {
      x(split({ ai: { speed: FAST, hp: hp(41) } }), '-1');
    });

    it('faster: otherwise -1', () => {
      // Gist error: at 40% or less it's +1 (script.s:3299–3301).
      x(split({ ai: { speed: FAST, hp: hp(40) } }), '+1');
    });
  });

  describe('Nightmare (Expert_Nightmare, script.s:3314)', () => {
    it('+2', () => {
      // Gist error: Expert_Nightmare scores Snore's DAMAGE_WHILE_ASLEEP (script.s:1691); Nightmare's own effect has no
      // Expert routine (and is on no hack move).
      x({ moves: [M.SNORE], effect: E.DAMAGE_WHILE_ASLEEP }, '+2');
      noHackMove(E.STATUS_NIGHTMARE);
    });
  });

  describe('Lock On, Mind Reader (Expert_LockOn, script.s:3319)', () => {
    it('1/2 +2', () => {
      x({ moves: [M.LOCK_ON], effect: E.NEXT_ATTACK_ALWAYS_HITS }, HALF_PLUS_2);
      x({ moves: [M.MIND_READER], effect: E.NEXT_ATTACK_ALWAYS_HITS }, HALF_PLUS_2);
    });
  });

  describe('Sleep Talk (Expert_SleepTalk, script.s:3327)', () => {
    it('asleep: +10; otherwise -5', () => {
      x({ moves: [M.SLEEP_TALK], effect: E.USE_RANDOM_LEARNED_MOVE_SLEEP, ai: { status: ASLEEP } }, '+10');
      x({ moves: [M.SLEEP_TALK] }, '-5');
    });
  });

  describe('Destiny Bond (Expert_DestinyBond, script.s:3335)', () => {
    const bond = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.DESTINY_BOND], effect: E.KO_MON_THAT_DEFEATED_USER, ...s });

    it('-1; slower ends there', () => {
      x(bond(), '-1');
      x(bond({ ai: { hp: hp(10) } }), '-1');
    });

    it('over 70% ends; else 1/2 +1', () => {
      x(bond({ ai: { speed: FAST, hp: hp(71) } }), '-1');
      x(bond({ ai: { speed: FAST, hp: hp(70) } }), '1/2: 0, 1/2: -1');
    });

    it('over 50% ends; else 1/2 +1 more', () => {
      x(bond({ ai: { speed: FAST, hp: hp(51) } }), '1/2: 0, 1/2: -1');
      x(bond({ ai: { speed: FAST, hp: hp(50) } }), '1/4: +1, 1/2: 0, 1/4: -1');
    });

    it('over 30% ends; else 156/256 +2 more', () => {
      x(bond({ ai: { speed: FAST, hp: hp(31) } }), '1/4: +1, 1/2: 0, 1/4: -1');
      x(bond({ ai: { speed: FAST, hp: hp(30) } }), '39/256: +3, 78/256: +2, 64/256: +1, 50/256: 0, 25/256: -1');
      x(bond({ ai: { speed: TIE, hp: hp(30) } }), '39/256: +3, 78/256: +2, 64/256: +1, 50/256: 0, 25/256: -1');
    });
  });

  describe('Reversal, Flail (Expert_Reversal, script.s:3362)', () => {
    const flail = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.FLAIL], effect: E.INCREASE_POWER_WITH_LESS_HP, ...s });
    const LIKELY_PLUS_1 = '156/256: +1, 100/256: 0';

    it('slower: over 60% -1', () => {
      x(flail(), '-1');
      x(flail({ ai: { hp: hp(61) } }), '-1');
    });

    it('slower: over 40% nothing', () => {
      x(flail({ ai: { hp: hp(60) } }), '0');
      x(flail({ ai: { hp: hp(41) } }), '0');
    });

    it('slower: otherwise 156/256 +1', () => {
      x(flail({ ai: { hp: hp(40) } }), LIKELY_PLUS_1);
      x({ moves: [M.REVERSAL], effect: E.INCREASE_POWER_WITH_LESS_HP, ai: { hp: hp(7) } }, LIKELY_PLUS_1);
    });

    it('faster: over 33% -1', () => {
      x(flail({ ai: { speed: FAST, hp: hp(34) } }), '-1');
    });

    it('faster: over 20% nothing', () => {
      x(flail({ ai: { speed: FAST, hp: hp(33) } }), '0');
      x(flail({ ai: { speed: FAST, hp: hp(21) } }), '0');
    });

    it('faster: 8% or more 156/256 +1', () => {
      x(flail({ ai: { speed: FAST, hp: hp(20) } }), LIKELY_PLUS_1);
      x(flail({ ai: { speed: FAST, hp: hp(8) } }), LIKELY_PLUS_1);
    });

    it('faster: under 8% 156/256 +2, else +1', () => {
      x(flail({ ai: { speed: FAST, hp: hp(7) } }), '156/256: +2, 100/256: +1');
      x({ moves: [M.REVERSAL], ai: { speed: FAST, hp: hp(7) } }, '156/256: +2, 100/256: +1');
    });
  });

  describe('Heal Bell, Aromatherapy (Expert_HealBell, script.s:3398)', () => {
    it('no status on the attacker or its party: -5', () => {
      x({ moves: [M.HEAL_BELL], effect: E.CURE_PARTY_STATUS }, '-5');
      x({ moves: [M.HEAL_BELL], ai: { status: MON_CONDITION_BURN } }, '0');
      x({ moves: [M.HEAL_BELL], aiBench: [{ status: MON_CONDITION_PARALYSIS }] }, '0');
      x({ moves: [M.HEAL_BELL], aiBench: [{ status: MON_CONDITION_PARALYSIS, hp: 0 }] }, '-5'); // a fainted member doesn't count
      x({ moves: [M.HEAL_BELL], player: { status: MON_CONDITION_BURN } }, '-5'); // the target's doesn't either
      x({ moves: [M.AROMATHERAPY], effect: E.CURE_PARTY_STATUS, aiBench: [{ status: ASLEEP }] }, '0');
    });
  });

  describe('Thief, Covet (Expert_Thief, script.s:3408)', () => {
    it('the target holding no encouraged item -2; else 206/256 +1: no move has the effect', () => {
      noHackMove(E.STEAL_HELD_ITEM);
      // Hack: Thief has DO_NOTHING and Covet's ID (343) is HP Grass, a plain hit.
      x({ moves: [M.THIEF], effect: E.DO_NOTHING, player: { item: I.LEFTOVERS } }, '0');
      x({ moves: [M.COVET], effect: E.HIT }, '0');
    });
  });

  describe('Curse (Expert_Curse, script.s:3452)', () => {
    const curse = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.CURSE], effect: E.CURSE, ...s });

    it('a Ghost: over 80% nothing, else -1', () => {
      x(curse({ ai: { types: ghost } }), '0');
      x(curse({ ai: { types: ghost, hp: hp(81) } }), '0');
      x(curse({ ai: { types: ghost, hp: hp(80) } }), '-1');
      x(curse({ ai: { types: [TYPE_NORMAL, TYPE_GHOST], hp: hp(80), stages: { defense: 6 } } }), '-1');
    });

    it('Defense at +3 or more: nothing', () => {
      // Gist error: IfStatStageGreaterThan 9 ends only from +4 (script.s:3471); at +3 the coin still rolls.
      x(curse({ ai: { stages: { defense: 4 } } }), '0');
      x(curse({ ai: { stages: { defense: 3 } } }), HALF_PLUS_1);
    });

    it('knows Gyro Ball or Trick Room: 224/256 +1', () => {
      // The 32/256 miss also skips the coin below (IfRandomLessThan 32 jumps past it, script.s:3477).
      x(curse({ moves: [M.CURSE, M.GYRO_BALL], ai: { stages: { defense: 2 } } }), '112/256: +2, 112/256: +1, 32/256: 0');
      x(curse({ moves: [M.CURSE, M.TRICK_ROOM], ai: { stages: { defense: 2 } } }), '112/256: +2, 112/256: +1, 32/256: 0');
    });

    it('then 1/2 +1', () => {
      x(curse({ ai: { stages: { defense: 2 } } }), HALF_PLUS_1);
    });

    it('Defense at +1 or lower: 1/2 +1 more', () => {
      x(curse({ ai: { stages: { defense: 1 } } }), '1/4: +2, 1/2: +1, 1/4: 0');
    });

    it('Defense at +0 or lower: 1/2 +1 more', () => {
      x(curse(), '1/8: +3, 3/8: +2, 3/8: +1, 1/8: 0');
      x(curse({ ai: { stages: { defense: -2 } } }), '1/8: +3, 3/8: +2, 3/8: +1, 1/8: 0');
    });
  });

  describe('Protect, Detect (Expert_Protect, script.s:3502)', () => {
    const protect = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.PROTECT], effect: E.PROTECT, ...s });
    /** A badly poisoned target: the +2, then the 1/2 -1. */
    const toxicTarget = { status: MON_CONDITION_TOXIC };
    const PLUS_2_THEN_HALF_MINUS_1 = '1/2: +2, 1/2: +1';

    it('the target knows Feint or Shadow Force: 1/2 -2', () => {
      x(protect({ player: toxicTarget, known: { moves: [M.FEINT] } }), '1/4: +2, 1/4: +1, 1/4: 0, 1/4: -1');
      x(protect({ player: toxicTarget, known: { moves: [M.SHADOW_FORCE] } }), '1/4: +2, 1/4: +1, 1/4: 0, 1/4: -1');
    });

    it('used Protect more than once already: -2 and end', () => {
      x(protect({ player: toxicTarget, ai: { effects: { protectSuccessTurns: 2 } }, patch: lastProtect(AI) }), '-2');
    });

    it('the attacker badly poisoned, cursed, under Perish Song, infatuated, seeded or drowsy, and not locked on: -2 and end', () => {
      const conditions = [
        { status: MON_CONDITION_TOXIC }, { statusVolatile: VOLATILE_CONDITION_CURSE }, { moveEffectsMask: MOVE_EFFECT_PERISH_SONG },
        { statusVolatile: VOLATILE_CONDITION_ATTRACT_0 }, { moveEffectsMask: MOVE_EFFECT_LEECH_SEED }, { moveEffectsMask: MOVE_EFFECT_YAWN_0 },
      ];
      for (const ai of conditions) x(protect({ ai, player: toxicTarget }), '-2');
      // Lock-On ends the routine with no change (script.s:3582–3583).
      x(protect({ ai: { status: MON_CONDITION_TOXIC, moveEffectsMask: MOVE_EFFECT_LOCK_ON_0 } }), '0');
    });

    it('the target knows a recovery move or Defense Curl, and not locked on: -2 and end', () => {
      x(protect({ known: { moves: [M.RECOVER] }, player: toxicTarget }), '-2');
      x(protect({ known: { moves: [M.RECOVER] }, ai: { moveEffectsMask: MOVE_EFFECT_LOCK_ON_0 } }), '0');
      // Hack: Defense Curl's ID (111) is "Rock Ball", a plain hit, and no move has its effect.
      noHackMove(E.DEF_UP_DOUBLE_ROLLOUT_POWER);
      x(protect({ known: { moves: [M.DEFENSE_CURL] }, player: toxicTarget }), PLUS_2_THEN_HALF_MINUS_1);
    });

    it('the target badly poisoned, cursed, under Perish Song, infatuated, seeded or drowsy: +2', () => {
      const conditions = [
        { status: MON_CONDITION_TOXIC }, { statusVolatile: VOLATILE_CONDITION_CURSE }, { moveEffectsMask: MOVE_EFFECT_PERISH_SONG },
        { statusVolatile: VOLATILE_CONDITION_ATTRACT_0 }, { moveEffectsMask: MOVE_EFFECT_LEECH_SEED }, { moveEffectsMask: MOVE_EFFECT_YAWN_0 },
      ];
      for (const player of conditions) x(protect({ player }), PLUS_2_THEN_HALF_MINUS_1);
      x({ moves: [M.DETECT], effect: E.PROTECT, player: toxicTarget }, PLUS_2_THEN_HALF_MINUS_1);
    });

    it('otherwise, a double battle: +2 (singles only here)', () => {
      // No singles battle path reaches this rule (the port throws UNSUPPORTED for doubles): this pins the singles result.
      x(protect(), '85/512: +2, 85/512: +1, 171/512: 0, 171/512: -1');
    });

    it('otherwise, locked on: +2', () => {
      x(protect({ ai: { moveEffectsMask: MOVE_EFFECT_LOCK_ON_0 } }), PLUS_2_THEN_HALF_MINUS_1);
    });

    it('otherwise: 85/256 +2', () => {
      x(protect(), '85/512: +2, 85/512: +1, 171/512: 0, 171/512: -1'); // IfRandomLessThan 85
    });

    it('then 1/2 -1', () => {
      x(protect({ player: toxicTarget }), PLUS_2_THEN_HALF_MINUS_1);
    });

    it('used Protect last turn: -1 and 1/2 -1 more', () => {
      x(protect({ player: toxicTarget, ai: { effects: { protectSuccessTurns: 1 } }, patch: lastProtect(AI) }), '1/4: +1, 1/2: 0, 1/4: -1');
      x(protect({ player: toxicTarget, ai: { effects: { protectSuccessTurns: 1 } }, patch: lastProtect(AI, M.ENDURE) }), '1/4: +1, 1/2: 0, 1/4: -1');
      // The chain counts only when the last such move was Protect, Detect or Endure (LoadProtectChain, trainer_ai.c:2545).
      x(protect({ player: toxicTarget, ai: { effects: { protectSuccessTurns: 1 } } }), PLUS_2_THEN_HALF_MINUS_1);
      // An unknown chain can't be read.
      x(protect({ patch: (v) => { v.unknown = [PATHS.moveProtect(AI)]; } }), { throws: 'UNDEFINED' });
    });
  });

  describe('Spikes (Expert_Spikes, script.s:3591)', () => {
    it('1/2 nothing and end; else +1', () => {
      x({ moves: [M.SPIKES], effect: E.SET_SPIKES }, HALF_PLUS_1);
    });

    it('knows Roar or Whirlwind: 192/256 +1 more', () => {
      x({ moves: [M.SPIKES, M.ROAR] }, '96/256: +2, 32/256: +1, 128/256: 0');
      x({ moves: [M.SPIKES, M.WHIRLWIND] }, '96/256: +2, 32/256: +1, 128/256: 0');
    });
  });

  describe('Foresight, Odor Sleuth (Expert_Foresight, script.s:3608)', () => {
    const TWO_ROLLS_PLUS_2 = '30976/65536: +2, 34560/65536: 0'; // (176/256)²

    it('the attacker a Ghost (the bug: not the target): (176/256)² +2', () => {
      x({ moves: [M.FORESIGHT], effect: E.FORESIGHT, ai: { types: ghost } }, TWO_ROLLS_PLUS_2);
      x({ moves: [M.ODOR_SLEUTH], effect: E.FORESIGHT, ai: { types: [TYPE_NORMAL, TYPE_GHOST] } }, TWO_ROLLS_PLUS_2);
      x({ moves: [M.FORESIGHT], player: { types: ghost } }, '-2');
    });

    it('target evasion +3 or more: 176/256 +2', () => {
      x({ moves: [M.FORESIGHT], player: { stages: { evasion: 3 } } }, '176/256: +2, 80/256: 0');
    });

    it('otherwise: -2', () => {
      x({ moves: [M.FORESIGHT] }, '-2');
      x({ moves: [M.FORESIGHT], player: { stages: { evasion: 2 } } }, '-2');
    });
  });

  describe('Miracle Eye (Expert_MiracleEye, script.s:4805)', () => {
    it('a Dark target: (176/256)² +2', () => {
      x({ moves: [M.MIRACLE_EYE], effect: E.IGNORE_EVATION_REMOVE_DARK_IMMUNE, player: { types: dark } }, '30976/65536: +2, 34560/65536: 0');
      x({ moves: [M.MIRACLE_EYE], player: { types: [TYPE_NORMAL, TYPE_DARK] } }, '30976/65536: +2, 34560/65536: 0');
    });

    it('target evasion +3 or more: 176/256 +2', () => {
      x({ moves: [M.MIRACLE_EYE], player: { stages: { evasion: 3 } } }, '176/256: +2, 80/256: 0');
    });

    it('otherwise: -2', () => {
      x({ moves: [M.MIRACLE_EYE] }, '-2');
    });
  });

  describe('Endure (Expert_Endure, script.s:3633)', () => {
    const endure = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ENDURE], effect: E.SURVIVE_WITH_1_HP, ...s });

    it('under 4% HP: -1', () => {
      x(endure({ ai: { hp: hp(3) } }), '-1');
    });

    it('under 35%: 186/256 +1', () => {
      x(endure({ ai: { hp: hp(4) } }), '186/256: +1, 70/256: 0');
      x(endure({ ai: { hp: hp(34) } }), '186/256: +1, 70/256: 0');
    });

    it('note: 35% or more: -1', () => {
      // Gist error (omission): from 35% the routine falls into Expert_Endure_ScoreMinus1 (script.s:3638–3641).
      x(endure({ ai: { hp: hp(35) } }), '-1');
      x(endure(), '-1');
    });
  });

  describe('Substitute (Expert_Substitute, script.s:2976)', () => {
    const sub = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.SUBSTITUTE], effect: E.SET_SUBSTITUTE, ...s });
    const LIKELY_PLUS_1 = '156/256: +1, 100/256: 0';
    /** Faster, at full HP, after the target's `prevMove`, with the target's own status as given. */
    const after = (prevMove: number, player: GistSetup['player'] = {}) => sub({ ai: { speed: FAST }, player: { prevMove, ...player } });

    it('knows Focus Punch: 160/256 +1', () => {
      x(sub(), '0');
      x(sub({ moves: [M.SUBSTITUTE, M.FOCUS_PUNCH] }), '160/256: +1, 96/256: 0'); // IfRandomLessThan 96
    });

    it('90% HP or less: one 156/256 -1 roll over 70%', () => {
      x(sub({ ai: { hp: hp(91) } }), '0');
      x(sub({ ai: { hp: hp(90) } }), '156/256: -1, 100/256: 0');
      x(sub({ ai: { hp: hp(71) } }), '156/256: -1, 100/256: 0');
    });

    it('two rolls over 50%', () => {
      x(sub({ ai: { hp: hp(70) } }), '24336/65536: -2, 31200/65536: -1, 10000/65536: 0');
      x(sub({ ai: { hp: hp(51) } }), '24336/65536: -2, 31200/65536: -1, 10000/65536: 0');
    });

    it('three rolls at 50% or less', () => {
      x(sub({ ai: { hp: hp(50) } }), '3796416/16777216: -3, 7300800/16777216: -2, 4680000/16777216: -1, 1000000/16777216: 0');
    });

    it('faster, a non-volatile status last move and the target statused: 156/256 +1', () => {
      // Gist error: the roll is for a target NOT statused (IfNotStatus, script.s:3027); a statused one gets nothing.
      x(after(M.TOXIC), LIKELY_PLUS_1);
      x(after(M.TOXIC, { status: MON_CONDITION_POISON }), '0');
      x(after(M.HYPNOSIS), LIKELY_PLUS_1);
      x(after(M.HYPNOSIS, { status: ASLEEP }), '0');
      x(after(M.POISON_POWDER), LIKELY_PLUS_1);
      x(after(M.THUNDER_WAVE), LIKELY_PLUS_1);
      x(after(M.WILL_O_WISP), LIKELY_PLUS_1);
      x(sub({ player: { prevMove: M.TOXIC } }), '0'); // slower: nothing
    });

    it('faster, a confusing last move and the target confused: 156/256 +1', () => {
      // Gist error: NOT confused (IfNotVolatileStatus, script.s:3031).
      x(after(M.CONFUSE_RAY), LIKELY_PLUS_1);
      x(after(M.CONFUSE_RAY, { statusVolatile: VOLATILE_CONDITION_CONFUSION_0 }), '0');
    });

    it('faster, Leech Seed last and the target seeded: 156/256 +1', () => {
      // Gist error: NOT seeded (IfMoveEffect ends the routine, script.s:3035).
      x(after(M.LEECH_SEED), LIKELY_PLUS_1);
      x(after(M.LEECH_SEED, { moveEffectsMask: MOVE_EFFECT_LEECH_SEED }), '0');
    });

    it('otherwise: nothing', () => {
      x(after(M.TACKLE), '0');
      x(after(M.GROWL), '0');
    });
  });

  describe('Baton Pass (Expert_BatonPass, script.s:3651)', () => {
    const pass = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.BATON_PASS], effect: E.PASS_STATS_AND_STATUS, ...s });
    const LIKELY_PLUS_2 = '176/256: +2, 80/256: 0';

    it('a stage at +3 or more: 176/256 +2 if slower at 70% or less, or faster at 60% or less; else nothing', () => {
      x(pass({ ai: { stages: { attack: 3 }, hp: hp(70) } }), LIKELY_PLUS_2);
      x(pass({ ai: { stages: { attack: 3 }, hp: hp(71) } }), '0');
      x(pass({ ai: { stages: { evasion: 3 }, speed: FAST, hp: hp(60) } }), LIKELY_PLUS_2);
      x(pass({ ai: { stages: { evasion: 3 }, speed: FAST, hp: hp(61) } }), '0');
    });

    it('a stage at +2: -2 if slower at 70% or less, or faster at 60% or less; else nothing', () => {
      // Gist error: the other way round. Slower, -2 at 70% or more (IfHPPercentLessThan 70 ends, script.s:3697–3698);
      // faster, -2 over 60% (:3694).
      x(pass({ ai: { stages: { defense: 2 }, hp: hp(69) } }), '0');
      x(pass({ ai: { stages: { defense: 2 }, hp: hp(70) } }), '-2');
      x(pass({ ai: { stages: { defense: 2 } } }), '-2');
      x(pass({ ai: { stages: { spAttack: 2 }, speed: FAST, hp: hp(60) } }), '0');
      x(pass({ ai: { stages: { spAttack: 2 }, speed: FAST, hp: hp(61) } }), '-2');
    });

    it('otherwise: -2', () => {
      x(pass(), '-2');
      x(pass({ ai: { stages: { speed: 3 }, hp: hp(50) } }), '-2'); // Speed isn't read
    });
  });

  describe('Pursuit (Expert_Pursuit, script.s:3706)', () => {
    const pursuit = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.PURSUIT], effect: E.HIT_BEFORE_SWITCH, ...s });

    it("the attacker's first turn in battle: 1/2 +1", () => {
      x(pursuit(), HALF_PLUS_1);
      x(pursuit({ turn: 1, ai: { effects: { fakeOutTurnNumber: 1 } } }), HALF_PLUS_1); // switched in last turn
      // Hack: Rage has Pursuit's effect.
      x({ moves: [M.RAGE], effect: E.HIT_BEFORE_SWITCH }, HALF_PLUS_1);
    });

    it('not its first turn, and a Ghost or Psychic target: 1/2 +1', () => {
      x(pursuit({ turn: 1 }), '0');
      x(pursuit({ turn: 1, player: { types: psychic } }), HALF_PLUS_1);
      x(pursuit({ turn: 1, player: { types: [TYPE_NORMAL, TYPE_GHOST] } }), HALF_PLUS_1);
      x(pursuit({ player: { types: psychic } }), HALF_PLUS_1); // one roll on the first turn
    });

    it('the target knows U-turn: 1/2 +1', () => {
      x(pursuit({ turn: 1, known: { moves: [M.U_TURN] } }), HALF_PLUS_1);
      x(pursuit({ known: { moves: [M.U_TURN] } }), '1/4: +2, 1/2: +1, 1/4: 0');
    });
  });

  describe('Rain Dance (Expert_RainDance, script.s:3737)', () => {
    const rain = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.RAIN_DANCE], effect: E.WEATHER_RAIN, ...s });
    // Each +1 or -1 ends the routine, so they never add up.

    it('slower with Swift Swim: +1 and end', () => {
      x(rain(), '0');
      x(rain({ ai: { ability: A.SWIFT_SWIM } }), '+1');
      x(rain({ ai: { ability: A.SWIFT_SWIM, hp: hp(39) } }), '+1');
      x(rain({ ai: { ability: A.SWIFT_SWIM, speed: FAST } }), '0');
      // The test is "not faster" (IfSpeedCompareEqualTo COMPARE_SPEED_FASTER, script.s:3747): a tie draws.
      x(rain({ ai: { ability: A.SWIFT_SWIM, speed: TIE } }), HALF_PLUS_1);
    });

    it('under 40% HP: -1', () => {
      x(rain({ ai: { hp: hp(39) } }), '-1');
      x(rain({ ai: { hp: hp(39) }, field: FIELD_CONDITION_SANDSTORM_PERM }), '-1');
    });

    it('hail, sun or sand: +1', () => {
      x(rain({ field: FIELD_CONDITION_HAILING_PERM }), '+1');
      x(rain({ field: FIELD_CONDITION_SUNNY_PERM }), '+1');
      x(rain({ field: FIELD_CONDITION_SANDSTORM_PERM, ai: { ability: A.RAIN_DISH } }), '+1');
      x(rain({ patch: (v) => { v.unknown = [PATHS.fog]; } }), { throws: 'UNDEFINED' });
    });

    it('Rain Dish, or Hydration and a status: +1', () => {
      x(rain({ ai: { ability: A.RAIN_DISH } }), '+1');
      x(rain({ ai: { ability: A.HYDRATION, status: MON_CONDITION_BURN } }), '+1');
      x(rain({ ai: { ability: A.HYDRATION } }), '0');
    });
  });

  describe('Sunny Day (Expert_SunnyDay, script.s:3773)', () => {
    const sun = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.SUNNY_DAY], effect: E.WEATHER_SUN, ...s });

    it('under 40% HP: -1', () => {
      x(sun({ ai: { hp: hp(39) } }), '-1');
      x(sun({ ai: { hp: hp(39), ability: A.FLOWER_GIFT }, field: FIELD_CONDITION_RAINING_PERM }), '-1');
    });

    it('hail, rain or sand: +1', () => {
      x(sun(), '0');
      x(sun({ field: FIELD_CONDITION_HAILING_PERM }), '+1');
      x(sun({ field: FIELD_CONDITION_RAINING_PERM }), '+1');
      x(sun({ field: FIELD_CONDITION_SANDSTORM_PERM, ai: { ability: A.FLOWER_GIFT } }), '+1');
    });

    it('Flower Gift, or Leaf Guard and a status (the bug): +1', () => {
      x(sun({ ai: { ability: A.FLOWER_GIFT } }), '+1');
      x(sun({ ai: { ability: A.LEAF_GUARD, status: MON_CONDITION_BURN } }), '+1');
      x(sun({ ai: { ability: A.LEAF_GUARD } }), '0');
    });
  });

  describe('Hail (Expert_Hail, script.s:4089)', () => {
    const hail = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.HAIL], effect: E.WEATHER_HAIL, ...s });

    it('under 40% HP: -1 and end', () => {
      x(hail({ ai: { hp: hp(39) }, field: FIELD_CONDITION_RAINING_PERM }), '-1');
    });

    it('sun, rain or sand: +1; knows Blizzard: +2 more', () => {
      x(hail(), '0');
      x(hail({ field: FIELD_CONDITION_SUNNY_PERM }), '+1');
      x(hail({ field: FIELD_CONDITION_RAINING_PERM }), '+1');
      x(hail({ field: FIELD_CONDITION_SANDSTORM_PERM }), '+1');
      x(hail({ moves: [M.HAIL, M.BLIZZARD], field: FIELD_CONDITION_RAINING_PERM }), '+3');
      x(hail({ moves: [M.HAIL, M.BLIZZARD] }), '0');
    });

    it('Ice Body: +2', () => {
      x(hail({ ai: { ability: A.ICE_BODY }, field: FIELD_CONDITION_RAINING_PERM }), '+3');
      x(hail({ moves: [M.HAIL, M.BLIZZARD], ai: { ability: A.ICE_BODY }, field: FIELD_CONDITION_SANDSTORM_PERM }), '+5');
      // Gist error: Ice Body is checked only after the weather's +1 (script.s:4101, 4108–4111); with none it's nothing.
      x(hail({ ai: { ability: A.ICE_BODY } }), '0');
    });
  });

  describe('Gravity (Expert_Gravity, script.s:4782)', () => {
    const gravity = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.GRAVITY], effect: E.GRAVITY, ...s });
    const LIKELY_PLUS_1 = '192/256: +1, 64/256: 0';

    it('the target with Levitate, Magnet Rise or a Flying type: 192/256 +1', () => {
      x(gravity({ player: { ability: A.LEVITATE } }), LIKELY_PLUS_1);
      x(gravity({ player: { moveEffectsMask: MOVE_EFFECT_MAGNET_RISE } }), LIKELY_PLUS_1);
      x(gravity({ player: { types: [TYPE_NORMAL, TYPE_FLYING] } }), LIKELY_PLUS_1);
      x(gravity({ ai: { hp: hp(10) }, player: { types: [TYPE_FLYING, TYPE_FLYING] } }), LIKELY_PLUS_1);
    });

    it('60% HP or more: 96/256 +1', () => {
      x(gravity(), '96/256: +1, 160/256: 0');
      x(gravity({ ai: { hp: hp(60) } }), '96/256: +1, 160/256: 0');
      x(gravity({ ai: { hp: hp(59) } }), '0');
    });
  });

  describe('Tailwind (Expert_Tailwind, script.s:4982)', () => {
    const tailwind = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.TAILWIND], effect: E.DOUBLE_SPEED_3_TURNS, ...s });

    it('1/4 nothing', () => {
      x(tailwind(), '192/256: +1, 64/256: 0'); // IfRandomLessThan 64 ends, else (slower, full HP) +1
    });

    it('faster: -1', () => {
      x(tailwind({ ai: { speed: FAST } }), '192/256: -1, 64/256: 0');
      x(tailwind({ ai: { speed: TIE } }), '96/256: -1, 96/256: +1, 64/256: 0'); // a tie draws
    });

    it('30% HP or less: -1', () => {
      x(tailwind({ ai: { hp: hp(30) } }), '192/256: -1, 64/256: 0');
    });

    it('over 75%: +1', () => {
      x(tailwind({ ai: { hp: hp(76) } }), '192/256: +1, 64/256: 0');
    });

    it('otherwise: 192/256 +1', () => {
      x(tailwind({ ai: { hp: hp(75) } }), '36864/65536: +1, 28672/65536: 0');
      x(tailwind({ ai: { hp: hp(31) } }), '36864/65536: +1, 28672/65536: 0');
    });
  });

  describe('Belly Drum (Expert_BellyDrum, script.s:3803)', () => {
    it('under 90% HP: -2', () => {
      x({ moves: [M.BELLY_DRUM], effect: E.MAX_ATK_LOSE_HALF_MAX_HP, ai: { hp: hp(89) } }, '-2');
      x({ moves: [M.BELLY_DRUM], ai: { hp: hp(90) } }, '0');
    });
  });

  describe('Psych Up (Expert_PsychUp, script.s:3814)', () => {
    const psych = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.PSYCH_UP], effect: E.COPY_STAT_CHANGES, ...s });
    const allUp: Partial<Record<StageName, number>> = { attack: 1, defense: 1, spAttack: 1, spDefense: 1, evasion: 1 };

    it("the target at +3 or more (Attack, Defense, Sp. Atk, Sp. Def, evasion), and our evasion at +0 or lower: +2", () => {
      // Gist error: the four +1 checks come first (script.s:3831–3835), so +2 needs all four above +0.
      x(psych({ player: { stages: { evasion: 3 } }, ai: { stages: { ...allUp, evasion: 0 } } }), '+2');
      x(psych({ player: { stages: { evasion: 3 } } }), '+1'); // all at +0: the first check
    });

    it('...and any of our Attack, Defense, Sp. Atk, Sp. Def at +0 or lower: +1', () => {
      x(psych({ player: { stages: { attack: 3 } } }), '+1');
      x(psych({ player: { stages: { spDefense: 3 } }, ai: { stages: { ...allUp, spDefense: -1 } } }), '+1');
    });

    it('...otherwise: 206/256 -2', () => {
      x(psych({ player: { stages: { defense: 3 } }, ai: { stages: allUp } }), '206/256: -2, 50/256: 0');
    });

    it('otherwise: -2', () => {
      x(psych(), '-2');
      x(psych({ player: { stages: { speed: 3 } } }), '-2'); // Speed isn't read
      x(psych({ player: { stages: { attack: 2 } } }), '-2');
    });
  });

  describe('Facade (Expert_Facade, script.s:4120)', () => {
    it('the target poisoned, burned or paralyzed (the bug: not the attacker): +1', () => {
      x({ moves: [M.FACADE], effect: E.DOUBLE_POWER_WHEN_STATUSED, player: { status: MON_CONDITION_BURN } }, '+1');
      x({ moves: [M.FACADE], player: { status: MON_CONDITION_POISON } }, '+1');
      x({ moves: [M.FACADE], player: { status: MON_CONDITION_TOXIC } }, '+1');
      x({ moves: [M.FACADE], player: { status: MON_CONDITION_PARALYSIS } }, '+1');
      x({ moves: [M.FACADE], player: { status: ASLEEP } }, '0');
      x({ moves: [M.FACADE], ai: { status: MON_CONDITION_BURN } }, '0');
    });
  });

  describe('Focus Punch (Expert_FocusPunch, script.s:4129)', () => {
    const punch = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.FOCUS_PUNCH], effect: E.HIT_LAST_WHIFF_IF_HIT, ...s });

    it('resisted or immune: -1', () => {
      x(punch({ player: { types: ghost } }), '-1');
      x(punch({ player: { types: [TYPE_POISON, TYPE_POISON] } }), '-1');
      x(punch({ player: { types: ghost }, ai: { statusVolatile: VOLATILE_CONDITION_SUBSTITUTE } }), '-1'); // and end
    });

    it('behind a Substitute: +5', () => {
      x(punch({ ai: { statusVolatile: VOLATILE_CONDITION_SUBSTITUTE } }), '+5');
      x(punch({ ai: { statusVolatile: VOLATILE_CONDITION_SUBSTITUTE }, player: { status: ASLEEP } }), '+5'); // and end
    });

    it('the target asleep: +1', () => {
      x(punch({ player: { status: ASLEEP } }), '+1');
    });

    it('the target confused or infatuated: 156/256 +1', () => {
      x(punch({ player: { statusVolatile: VOLATILE_CONDITION_CONFUSION_0 } }), '156/256: +1, 100/256: 0');
      x(punch({ player: { statusVolatile: VOLATILE_CONDITION_ATTRACT_0 }, turn: 1 }), '156/256: +1, 100/256: 0'); // and end
    });

    it("not the attacker's first turn: 56/256 +1", () => {
      x(punch(), '0');
      x(punch({ turn: 1 }), '56/256: +1, 200/256: 0'); // IfRandomLessThan 200
    });
  });

  describe('Smelling Salt (Expert_SmellingSalts, script.s:4165)', () => {
    it('the target paralyzed: +2', () => {
      // Gist error: +1 (script.s:4171).
      x({ moves: [M.SMELLING_SALT], effect: E.DOUBLE_POWER_AND_CURE_PARALYSIS, player: { status: MON_CONDITION_PARALYSIS } }, '+1');
      x({ moves: [M.SMELLING_SALT] }, '0');
    });
  });

  describe('Wake-Up Slap (Expert_WakeUpSlap, script.s:4829)', () => {
    it('resisted or immune: -1', () => {
      x({ moves: [M.WAKE_UP_SLAP], effect: E.DOUBLE_POWER_HEAL_SLEEP, player: { types: ghost, status: ASLEEP } }, '-1');
    });

    it('the target asleep: +1', () => {
      x({ moves: [M.WAKE_UP_SLAP] }, '0');
      x({ moves: [M.WAKE_UP_SLAP], player: { status: ASLEEP } }, '+1');
    });
  });

  describe('Trick, Switcheroo (Expert_Trick, script.s:4176)', () => {
    it('every rule (disruptive, poisoning, burning, Black Sludge and flavour-berry items): no move has the effect', () => {
      // The script also differs from the gist: an item in none of the tables gives -3, and a Klutz attacker with a
      // burning item -5 (script.s:4229, 4293); neither can fire in the hack.
      noHackMove(E.SWITCH_HELD_ITEMS);
      // Hack: 271 and 415 are HP Psychic and HP Flying, plain hits.
      x({ moves: [M.TRICK], effect: E.HIT, ai: { item: I.TOXIC_ORB } }, '0');
      x({ moves: [M.SWITCHEROO], effect: E.HIT, ai: { item: I.TOXIC_ORB } }, '0');
    });
  });

  describe("Moves that change the user's ability (Expert_ChangeUserAbility, script.s:4415)", () => {
    const play = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ROLE_PLAY], effect: E.COPY_ABILITY, ...s });
    const LIKELY_PLUS_2 = '206/256: +2, 50/256: 0';

    it('the attacker has a desirable ability: -1', () => {
      x(play({ ai: { ability: A.SPEED_BOOST }, player: { ability: A.HUGE_POWER } }), '-1');
    });

    it('the target has a desirable ability: 206/256 +2', () => {
      x(play({ player: { ability: A.HUGE_POWER } }), LIKELY_PLUS_2);
      x(play({ player: { ability: A.BATTLE_ARMOR } }), LIKELY_PLUS_2);
      x({ moves: [M.SKILL_SWAP], effect: E.SWITCH_ABILITIES, player: { ability: A.WONDER_GUARD } }, LIKELY_PLUS_2);
    });

    it('note: neither: -1', () => {
      // Gist error (omission): the routine falls into its -1 (script.s:4422–4425).
      x(play(), '-1');
      x(play({ player: { ability: A.SHELL_ARMOR } }), '-1'); // not listed, unlike Battle Armor
    });
  });

  describe('Moves that weaken with less user HP (Expert_WaterSpout, script.s:4610)', () => {
    const spout = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.WATER_SPOUT], effect: E.DECREASE_POWER_WITH_LESS_USER_HP, ...s });

    it('resisted or immune: -1', () => {
      x(spout({ player: { types: [TYPE_WATER, TYPE_WATER] } }), '-1');
      x(spout({ player: { types: [TYPE_WATER, TYPE_WATER], hp: hp(10) } }), '-1'); // and end
    });

    it('slower, the target at 70% or less: -1', () => {
      x(spout(), '0');
      x(spout({ player: { hp: hp(70) } }), '-1');
      x(spout({ player: { hp: hp(71) } }), '0');
    });

    it('faster, the target at 50% or less (the bug: not our HP): -1', () => {
      x(spout({ ai: { speed: FAST }, player: { hp: hp(50) } }), '-1');
      x(spout({ ai: { speed: FAST }, player: { hp: hp(51) } }), '0');
      x(spout({ ai: { speed: FAST, hp: hp(10) } }), '0');
    });

    it('hack: Eruption is a recoil move', () => {
      x({ moves: [M.ERUPTION], effect: E.RECOIL_BURN_HIT, player: { hp: hp(50) } }, '0');
    });
  });

  describe('Superpower (Expert_Superpower, script.s:4467; the hack\'s effect-182 moves)', () => {
    // Hack: effect 182 (vanilla Superpower's LOWER_OWN_ATK_AND_DEF) is on Take Down, Close Combat and Brave Bird
    // (docs/ai-changes.md). The first condition that holds gives -1 and ends the routine.
    const combat = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.CLOSE_COMBAT], effect: E.LOWER_OWN_ATK_AND_DEF, ...s });

    it('resisted or immune: -1', () => {
      x(combat({ ai: { hp: hp(59) }, player: { types: ghost } }), '-1');
      x(combat({ player: { types: ghost } }), '-1'); // not -2
    });

    it('Attack at -1 or lower: -1', () => {
      x(combat({ ai: { hp: hp(59), stages: { attack: -1 } } }), '-1');
      x(combat({ ai: { speed: FAST, hp: hp(40), stages: { attack: -1 } } }), '-1');
    });

    it('slower, 60% HP or more: -1', () => {
      x(combat(), '-1');
      x(combat({ ai: { hp: hp(60) } }), '-1');
      x(combat({ ai: { hp: hp(59) } }), '0');
    });

    it('faster, over 40%: -1', () => {
      x(combat({ ai: { speed: FAST, hp: hp(41) } }), '-1');
      x(combat({ ai: { speed: FAST, hp: hp(40) } }), '0');
      x(combat({ ai: { speed: TIE, hp: hp(59) } }), '-1'); // a tie counts as faster
    });

    it('hack: Take Down and Brave Bird take the routine; Superpower has effect 48 (RECOIL_QUARTER)', () => {
      x({ moves: [M.TAKE_DOWN], effect: E.LOWER_OWN_ATK_AND_DEF }, '-1');
      x({ moves: [M.BRAVE_BIRD], effect: E.LOWER_OWN_ATK_AND_DEF }, '-1');
      expect(hackEffect(M.SUPERPOWER)).toBe(E.RECOIL_QUARTER);
      x({ moves: [M.SUPERPOWER] }, '0');
    });
  });

  describe('Magic Coat (Expert_MagicCoat, script.s:4492)', () => {
    const coat = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.MAGIC_COAT], effect: E.APPLY_MAGIC_COAT, ...s });

    it('the target at 30% HP or less: 156/256 -1', () => {
      x(coat({ player: { hp: hp(30) } }), '10600/65536: +1, 31536/65536: 0, 23400/65536: -1');
      x(coat({ player: { hp: hp(30) }, turn: 1 }), '35256/65536: -2, 27280/65536: -1, 3000/65536: 0');
    });

    it("the attacker's first turn: 106/256 +1", () => {
      x(coat(), '106/256: +1, 150/256: 0'); // IfRandomLessThan 150
    });

    it('not its first turn: 226/256 -1', () => {
      x(coat({ turn: 1 }), '226/256: -1, 30/256: 0'); // IfRandomLessThan 30
    });
  });

  describe('Recycle (Expert_Recycle, script.s:4517)', () => {
    const recycle = (item: number, s: Partial<GistSetup> = {}): GistSetup => ({
      moves: [M.RECYCLE], effect: E.RECYCLE, recycleItem: [0, item, 0, 0], ...s,
    });

    it('the recyclable item not a Chesto, Lum or Starf Berry: -2', () => {
      x(recycle(I.NONE), '-2');
      x(recycle(I.ORAN_BERRY), '-2');
      x({ moves: [M.RECYCLE], recycleItem: [I.LUM_BERRY, 0, 0, 0] }, '-2'); // the target's doesn't count
    });

    it('otherwise: 206/256 +1', () => {
      x(recycle(I.CHESTO_BERRY), '206/256: +1, 50/256: 0');
      x(recycle(I.LUM_BERRY), '206/256: +1, 50/256: 0');
      x(recycle(I.STARF_BERRY), '206/256: +1, 50/256: 0');
      // An unknown recyclable item can't be read.
      x(recycle(I.LUM_BERRY, { patch: (v) => { v.unknown = [PATHS.recycleItem(AI)]; } }), { throws: 'UNDEFINED' });
    });
  });

  describe('Double-power negative-priority moves (Expert_Revenge, script.s:4542)', () => {
    it('the target asleep, infatuated or confused -2; else 180/256 -2, 76/256 +2: no move has the effect', () => {
      noHackMove(E.DOUBLE_POWER_IF_HIT);
      // Hack: Revenge has Payback's effect, so Expert_Payback scores it; Avalanche is a flinching Ice hit.
      x({ moves: [M.REVENGE], effect: E.DOUBLE_POWER_IF_MOVING_SECOND, player: { status: ASLEEP } }, '192/256: +1, 64/256: 0');
      x({ moves: [M.AVALANCHE], effect: E.FLINCH_FREEZE_HIT, player: { status: ASLEEP } }, '0');
    });
  });

  describe('Brick Break (Expert_BrickBreak, script.s:4559)', () => {
    it("Reflect or Light Screen on the target's side: +1", () => {
      x({ moves: [M.BRICK_BREAK], effect: E.REMOVE_SCREENS }, '0');
      x({ moves: [M.BRICK_BREAK], sides: [SIDE_CONDITION_REFLECT, 0] }, '+1');
      x({ moves: [M.BRICK_BREAK], sides: [SIDE_CONDITION_LIGHT_SCREEN, 0] }, '+1');
      x({ moves: [M.BRICK_BREAK], sides: [SIDE_CONDITION_REFLECT | SIDE_CONDITION_LIGHT_SCREEN, 0] }, '+1');
      x({ moves: [M.BRICK_BREAK], sides: [0, SIDE_CONDITION_REFLECT] }, '0');
    });
  });

  describe('Knock Off (Expert_KnockOff, script.s:4571)', () => {
    it("the target at 30% HP or more and not the attacker's first turn: 76/256 +1", () => {
      x({ moves: [M.KNOCK_OFF], effect: E.REMOVE_HELD_ITEM }, '0');
      x({ moves: [M.KNOCK_OFF], turn: 1 }, '76/256: +1, 180/256: 0'); // IfRandomLessThan 180
      x({ moves: [M.KNOCK_OFF], turn: 1, player: { hp: hp(30) } }, '76/256: +1, 180/256: 0');
      x({ moves: [M.KNOCK_OFF], turn: 1, player: { hp: hp(29) } }, '0');
    });
  });

  describe('Endeavor (Expert_Endeavor, script.s:4583)', () => {
    const endeavor = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ENDEAVOR], effect: E.SET_HP_EQUAL_TO_USER, ...s });

    it('the target under 70%: -1 and end', () => {
      x(endeavor({ player: { hp: hp(69) }, ai: { hp: hp(10) } }), '-1');
    });

    it('slower: over 50% -1, else +1', () => {
      x(endeavor(), '-1');
      x(endeavor({ ai: { hp: hp(51) } }), '-1');
      x(endeavor({ ai: { hp: hp(50) }, player: { hp: hp(70) } }), '+1');
    });

    it('faster: over 40% -1, else +1', () => {
      x(endeavor({ ai: { speed: FAST, hp: hp(41) } }), '-1');
      x(endeavor({ ai: { speed: FAST, hp: hp(40) } }), '+1');
    });
  });

  describe('Imprison (Expert_Imprison, script.s:4634)', () => {
    it("not the attacker's first turn: 156/256 +2", () => {
      x({ moves: [M.IMPRISON], effect: E.MAKE_SHARED_MOVES_UNUSEABLE }, '0');
      x({ moves: [M.IMPRISON], turn: 1 }, '156/256: +2, 100/256: 0');
    });
  });

  describe('Refresh (Expert_Refresh, script.s:4644)', () => {
    it('the target under 50%: -1', () => {
      x({ moves: [M.REFRESH], effect: E.HEAL_STATUS, player: { hp: hp(49) } }, '-1');
      x({ moves: [M.REFRESH], player: { hp: hp(50) } }, '0');
    });
  });

  describe('Snatch (Expert_Snatch, script.s:4655)', () => {
    it('every rule (first turn 106/256 +2, the 30/256 stop, the slower and faster rolls): no move has the effect', () => {
      noHackMove(E.STEAL_STATUS_MOVE);
      // Hack: 289 is Drill Run, a high-crit Ground hit.
      x({ moves: [M.SNATCH], effect: E.HIGH_CRITICAL }, '64/256: +1, 192/256: 0');
    });
  });

  describe('Mud Sport, Water Sport (Expert_MudSport, :4701; Expert_WaterSport, :4744)', () => {
    it('under 50% -1; an Electric or Fire target +1: no move has either effect', () => {
      noHackMove(E.HALVE_ELECTRIC_DAMAGE, E.HALVE_FIRE_DAMAGE);
      // Hack: 300 is HP Ground, a plain hit; Water Sport is Scald (THAW_AND_BURN_HIT).
      x({ moves: [M.MUD_SPORT], effect: E.HIT, player: { types: [TYPE_FIGHTING, TYPE_FIGHTING] } }, '0');
      x({ moves: [M.WATER_SPORT], effect: E.THAW_AND_BURN_HIT, player: { types: [TYPE_FIRE, TYPE_FIRE] } }, '0');
    });
  });

  describe("Moves lowering the user's Sp. Atk by 2 (Expert_Overheat, script.s:4722)", () => {
    it('resisted -1; faster at 60% or less -1; slower at 80% or less -1: no move has the effect', () => {
      noHackMove(E.USER_SP_ATK_DOWN_2);
      // Hack: Overheat is a recoil move and Draco Meteor has effect 48; Leaf Storm and Psycho Boost are plain hits.
      x({ moves: [M.OVERHEAT], effect: E.RECOIL_BURN_HIT, ai: { hp: hp(80) } }, '0');
      x({ moves: [M.DRACO_METEOR], effect: E.RECOIL_QUARTER, ai: { hp: hp(80) } }, '0');
      x({ moves: [M.LEAF_STORM], effect: E.HIT, ai: { hp: hp(80) } }, '0');
      x({ moves: [M.PSYCHO_BOOST], effect: E.HIT, ai: { hp: hp(80) } }, '0');
    });
  });

  describe('Hammer Arm (Expert_HammerArm, script.s:4849)', () => {
    it('resisted or immune: -1', () => {
      x({ moves: [M.HAMMER_ARM], effect: E.SPEED_DOWN_HIT, player: { types: ghost } }, '-1');
    });

    it('slower: +1', () => {
      x({ moves: [M.HAMMER_ARM] }, '+1');
      x({ moves: [M.HAMMER_ARM], ai: { speed: FAST } }, '0');
      x({ moves: [M.HAMMER_ARM], ai: { speed: TIE } }, '0'); // a tie isn't slower
    });
  });

  describe('Brine (Expert_Brine, script.s:4873)', () => {
    it('resisted or immune: -1', () => {
      x({ moves: [M.BRINE], effect: E.DOUBLE_POWER_WHEN_BELOW_HALF, player: { types: [TYPE_WATER, TYPE_WATER], hp: hp(50) } }, '-1');
    });

    it('the target at 50% or less: 1/2 +1, 1/2 +2', () => {
      x({ moves: [M.BRINE] }, '0');
      x({ moves: [M.BRINE], player: { hp: hp(51) } }, '0');
      x({ moves: [M.BRINE], player: { hp: hp(50) } }, '1/2: +2, 1/2: +1');
      // Hack: Wring Out has Brine's effect.
      x({ moves: [M.WRING_OUT], effect: E.DOUBLE_POWER_WHEN_BELOW_HALF, player: { hp: hp(50) } }, '1/2: +2, 1/2: +1');
    });
  });

  describe('Feint (Expert_Feint, script.s:4892)', () => {
    /** Feint against a target known to have Protect, so the 1/4 gate is skipped. */
    const feint = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.FEINT], effect: E.REMOVE_PROTECT, known: { moves: [M.PROTECT] }, ...s });
    const chain = (turns: number): Partial<GistSetup> => ({ player: { effects: { protectSuccessTurns: turns } }, patch: lastProtect(PLAYER) });
    const TWO_COINS = '1/4: +2, 1/2: +1, 1/4: 0';

    it("the target doesn't know Protect: 192/256 nothing", () => {
      x({ moves: [M.FEINT] }, '32/256: +1, 224/256: 0'); // IfRandomLessThan 64 goes on, then the chain-0 coin
    });

    it('the attacker badly poisoned, cursed, under Perish Song, infatuated, seeded or drowsy: 1/2 +1', () => {
      x(feint({ ai: { status: MON_CONDITION_TOXIC } }), TWO_COINS);
      x(feint({ ai: { statusVolatile: VOLATILE_CONDITION_CURSE } }), TWO_COINS);
      x(feint({ ai: { moveEffectsMask: MOVE_EFFECT_PERISH_SONG } }), TWO_COINS);
      x(feint({ ai: { statusVolatile: VOLATILE_CONDITION_ATTRACT_0 } }), TWO_COINS);
      x(feint({ ai: { moveEffectsMask: MOVE_EFFECT_LEECH_SEED } }), TWO_COINS);
      x(feint({ ai: { moveEffectsMask: MOVE_EFFECT_YAWN_0 } }), TWO_COINS);
    });

    it('otherwise, the target not at full HP with Leftovers or Black Sludge: 1/2 +1', () => {
      x(feint({ player: { hp: hp(99), item: I.LEFTOVERS } }), TWO_COINS);
      x(feint({ player: { hp: hp(99), item: I.BLACK_SLUDGE } }), TWO_COINS);
      x(feint({ player: { item: I.LEFTOVERS } }), HALF_PLUS_1);
      x(feint({ player: { hp: hp(99) } }), HALF_PLUS_1);
    });

    it("the target's Protect chain at 0: 1/2 +1", () => {
      x(feint(), HALF_PLUS_1);
    });

    it('chain at 1: 64/256 +1', () => {
      x(feint(chain(1)), '64/256: +1, 192/256: 0'); // IfRandomLessThan 192
    });

    it('otherwise: -2', () => {
      x(feint(chain(3)), '-2');
      // Gist error: a chain of exactly 2 falls through to the chain-0 coin (IfLoadedGreaterThan 2, script.s:4934–4936).
      x(feint(chain(2)), HALF_PLUS_1);
      x(feint({ patch: (v) => { v.unknown = [PATHS.moveProtect(PLAYER)]; } }), { throws: 'UNDEFINED' });
    });
  });

  describe('Pluck, Bug Bite (Expert_Pluck, script.s:4957)', () => {
    it('resisted or immune: -1', () => {
      x({ moves: [M.PLUCK], effect: E.EAT_BERRY, player: { types: [TYPE_ROCK, TYPE_ROCK] } }, '-1');
      x({ moves: [M.BUG_BITE], effect: E.EAT_BERRY, player: { types: [TYPE_FIRE, TYPE_FIRE] } }, '-1');
    });

    it("the attacker's first turn: 192/256 +1", () => {
      x({ moves: [M.PLUCK] }, '96/256: +2, 128/256: +1, 32/256: 0');
      x({ moves: [M.BUG_BITE] }, '96/256: +2, 128/256: +1, 32/256: 0');
    });

    it('then 1/2 +1', () => {
      x({ moves: [M.PLUCK], turn: 1 }, HALF_PLUS_1);
    });
  });

  describe('U-turn (Expert_UTurn, script.s:5085)', () => {
    /** A bench member whose Mega Kick out-damages U-turn (IfPartyMemberDealsMoreDamage jumps). */
    const stronger = [{ moves: [M.MEGA_KICK, 0, 0, 0], pp: [5, 0, 0, 0], ppMax: [5, 0, 0, 0] }];
    const uturn = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.U_TURN], effect: E.SWITCH_HIT, aiBench: stronger, ...s });

    it('resisted or immune: -1 and end', () => {
      x(uturn({ player: { types: [TYPE_FIRE, TYPE_FIRE] } }), '-1');
    });

    it('the last Pokémon standing: +2 and end', () => {
      // Gist error: CountAlivePartyBattlers 0 ends the routine with no change (script.s:5104–5105).
      x(uturn({ aiBench: 0 }), '0');
      x(uturn({ aiBench: [{ hp: 0 }] }), '0');
    });

    it('has a super-effective move: 192/256 -2', () => {
      x(uturn({ ai: { speed: FAST }, player: { types: psychic, hp: hp(50) } }), '32/256: +2, 32/256: +1, 96/256: 0, 96/256: -1');
      // Reading the moves' types, Weather Ball with no weather has none.
      x(uturn({ moves: [M.U_TURN, M.WEATHER_BALL] }), { throws: 'UNDEFINED' });
    });

    it('no party member deals more damage: 192/256 -2 and end', () => {
      // The default bench member's Tackle deals less than U-turn.
      x(uturn({ aiBench: 1, ai: { speed: FAST }, player: { hp: hp(50) } }), '32/256: +2, 32/256: +1, 192/256: -2');
      x(uturn({ aiBench: 1 }), '3/64: +3, 7/64: +2, 5/64: +1, 1/64: 0, 48/64: -2');
    });

    it('the target over 70%: 192/256 +1', () => {
      x(uturn({ ai: { speed: FAST } }), '3/8: +3, 4/8: +2, 1/8: +1');
    });

    it('over 30%: 1/2 +1 more', () => {
      x(uturn({ ai: { speed: FAST }, player: { hp: hp(70) } }), '1/2: +2, 1/2: +1');
      x(uturn({ ai: { speed: FAST }, player: { hp: hp(31) } }), '1/2: +2, 1/2: +1');
    });

    it('otherwise: 1/4 +1', () => {
      x(uturn({ ai: { speed: FAST }, player: { hp: hp(30) } }), '1/4: +2, 3/4: +1');
    });

    it('faster: +1; otherwise 1/2 +1', () => {
      x(uturn({ player: { hp: hp(50) } }), '1/4: +2, 1/2: +1, 1/4: 0');
      x(uturn({ ai: { speed: TIE }, player: { hp: hp(50) } }), '3/8: +2, 4/8: +1, 1/8: 0'); // a tie: 1/2 faster
    });
  });

  describe('Close Combat (Expert_CloseCombat, script.s:5147)', () => {
    it('resisted -1; slower at 80% or less -1; faster at 60% or less -1: no move has the effect', () => {
      noHackMove(E.DEF_SPD_DOWN_HIT);
      // Hack: Close Combat has Superpower's effect (182), so it is scored as Superpower (see that section).
      x({ moves: [M.CLOSE_COMBAT], effect: E.LOWER_OWN_ATK_AND_DEF, ai: { hp: hp(80) } }, '-1');
    });
  });

  describe('Payback (Expert_Payback, script.s:5169)', () => {
    const payback = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.PAYBACK], effect: E.DOUBLE_POWER_IF_MOVING_SECOND, ...s });
    const LIKELY_PLUS_1 = '192/256: +1, 64/256: 0';

    it('resisted or immune: -1', () => {
      x(payback({ player: { types: dark } }), '-1');
    });

    it('slower and 30% HP or more: 192/256 +1', () => {
      x(payback(), LIKELY_PLUS_1);
      x(payback({ ai: { hp: hp(30) } }), LIKELY_PLUS_1);
      x(payback({ ai: { hp: hp(29) } }), '0');
      x(payback({ ai: { speed: FAST } }), '0');
      x(payback({ ai: { speed: TIE } }), '96/256: +1, 160/256: 0'); // the test is "faster": a tie draws
      // Hack: Revenge has Payback's effect (vanilla DOUBLE_POWER_IF_HIT).
      x({ moves: [M.REVENGE], effect: E.DOUBLE_POWER_IF_MOVING_SECOND }, LIKELY_PLUS_1);
    });
  });

  describe('Assurance (Expert_Assurance, script.s:5189)', () => {
    const assurance = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ASSURANCE], effect: E.DOUBLE_POWER_IF_TARGET_HIT, ...s });
    const QUARTER_PLUS_1 = '64/256: +1, 192/256: 0';

    it('resisted or immune: -1', () => {
      x(assurance({ player: { types: dark } }), '-1');
    });

    it('slower with Rough Skin: 1/2 +1', () => {
      x(assurance({ ai: { ability: A.ROUGH_SKIN } }), HALF_PLUS_1);
      x(assurance({ ai: { ability: A.ROUGH_SKIN, speed: FAST } }), '0');
    });

    it('slower holding a Jaboca or Rowap Berry: 1/2 +1', () => {
      // Gist error: the table holds item IDs but is tested against the hold effect (LoadHeldItemEffect, script.s:5202–5203,
      // 5218–5220), so it never matches: 1/4, as for any other item.
      x(assurance({ ai: { item: I.JABOCA_BERRY } }), QUARTER_PLUS_1);
      x(assurance({ ai: { item: I.ROWAP_BERRY } }), QUARTER_PLUS_1);
    });

    it('slower, otherwise: 1/4 +1', () => {
      x(assurance(), QUARTER_PLUS_1);
      x(assurance({ ai: { speed: FAST } }), '0');
    });
  });

  describe('Embargo (Expert_Embargo, script.s:5223)', () => {
    it('1/2 +1', () => {
      x({ moves: [M.EMBARGO], effect: E.PREVENT_ITEM_USE }, HALF_PLUS_1);
    });
  });

  describe('Fling (Expert_Fling, script.s:5231)', () => {
    const fling = (item: number, s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.FLING], effect: E.FLING, ai: { item }, ...s });

    it("resisted or immune, holding anything but King's Rock, Razor Fang, Poison Barb, Toxic Orb, Flame Orb or Light Ball: -1", () => {
      x(fling(I.IRON_BALL, { player: { types: dark } }), '-1');
      x(fling(I.LEFTOVERS, { player: { types: dark } }), '-1');
      for (const item of [I.KINGS_ROCK, I.POISON_BARB, I.TOXIC_ORB, I.FLAME_ORB, I.LIGHT_BALL]) {
        x(fling(item, { player: { types: dark } }), '0');
      }
    });

    it('Fling power under 30: -2', () => {
      x(fling(I.LEFTOVERS), '-2'); // 10 in the hack's item data
      x(fling(I.NONE), '-2');
    });

    it('over 90: 192/256 +1; super effective +4, else 1/2 +1', () => {
      x(fling(I.IRON_BALL), '96/256: +2, 128/256: +1, 32/256: 0'); // 130
      x(fling(I.HARD_STONE), '96/256: +2, 128/256: +1, 32/256: 0'); // 100
      x(fling(I.IRON_BALL, { player: { types: psychic } }), '192/256: +5, 64/256: +4');
    });

    it('over 60: 192/256 +1', () => {
      x(fling(I.POISON_BARB), '192/256: +1, 64/256: 0'); // 70
      x(fling(I.SHINY_STONE), '192/256: +1, 64/256: 0'); // 80
    });

    it('otherwise: 1/2 -1', () => {
      x(fling(I.TOXIC_ORB), '1/2: -1, 1/2: 0'); // 30
      x(fling(I.KINGS_ROCK), '1/2: -1, 1/2: 0');
    });
  });

  describe('Psycho Shift (Expert_PsychoShift, script.s:5296)', () => {
    const shift = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.PSYCHO_SHIFT], effect: E.TRANSFER_STATUS, ...s });

    it('the attacker has no status: -10', () => {
      x(shift(), '-10');
    });

    it('the target at 30% or more: 1/2 +1', () => {
      x(shift({ ai: { status: MON_CONDITION_BURN } }), HALF_PLUS_1);
      x(shift({ ai: { status: MON_CONDITION_BURN }, player: { hp: hp(30) } }), HALF_PLUS_1);
      x(shift({ ai: { status: MON_CONDITION_BURN }, player: { hp: hp(29) } }), '0');
    });
  });

  describe('Trump Card (Expert_TrumpCard, script.s:5308)', () => {
    // Hack: Trump Card's maximum PP is 1, so at full PP it always has 1 left and the rules after +3 can't fire in battle.
    // Their cases give the slot more PP than that, to run the hack's routine past the PP checks.
    const card = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.TRUMP_CARD], effect: E.HIGHER_POWER_WHEN_LOW_PP, ...s });
    /** No singles battle path has this setup: `n` PP is above Trump Card's maximum of 1 in the hack. */
    const pp = (n: number, s: Partial<GistSetup> = {}): GistSetup => card({ ...s, ai: { pp: [n], ...s.ai } });
    const LIKELY_PLUS_1 = '156/256: +1, 100/256: 0';
    const LIKELY_PLUS_2 = '156/256: +2, 100/256: +1';

    it('resisted or immune: -1', () => {
      x(card({ player: { types: ghost } }), '-1');
    });

    it('1 PP left: +3', () => {
      x(card(), '+3');
      x(card({ player: { ability: A.PRESSURE } }), '+3'); // and the routine ends
    });

    it('2 PP: 156/256 +2, else +1', () => {
      x(pp(2), LIKELY_PLUS_2);
    });

    it('3 PP: 156/256 +1', () => {
      x(pp(3), LIKELY_PLUS_1);
      x(pp(4), '0');
    });

    it('Pressure: 226/256 +1', () => {
      x(pp(5, { player: { ability: A.PRESSURE } }), '226/256: +1, 30/256: 0');
      x(pp(5, { player: { ability: A.PRESSURE, stages: { evasion: 3 } } }), '35256/65536: +2, 27280/65536: +1, 3000/65536: 0');
    });

    it('target evasion +5 or more, or attacker accuracy -5 or less: 156/256 +2, else +1', () => {
      x(pp(5, { player: { stages: { evasion: 5 } } }), LIKELY_PLUS_2);
      x(pp(5, { ai: { pp: [5], stages: { accuracy: -5 } } }), LIKELY_PLUS_2);
    });

    it('target evasion +3 or more, or attacker accuracy -3 or less: 156/256 +1', () => {
      x(pp(5, { player: { stages: { evasion: 3 } } }), LIKELY_PLUS_1);
      x(pp(5, { ai: { pp: [5], stages: { accuracy: -3 } } }), LIKELY_PLUS_1);
      x(pp(5, { player: { stages: { evasion: 2 } } }), '0');
    });
  });

  describe('Heal Block (Expert_HealBlock, script.s:5361)', () => {
    it('the target knowing a healing move 231/256 +1; seeded us or rooted it 231/256 +1; else 160/256 × 231/256: no move has the effect', () => {
      noHackMove(E.PREVENT_HEALING);
      // Hack: 377 is Aqua Cutter, a high-crit Water hit.
      x({ moves: [M.HEAL_BLOCK], effect: E.HIGH_CRITICAL, known: { moves: [M.RECOVER] } }, '64/256: +1, 192/256: 0');
    });
  });

  describe('Wring Out, Crush Grip (Expert_WringOut, script.s:5405)', () => {
    it('resisted -1; under 50% -1; full HP up to +3; over 85% 231/256 +1: no move has the effect', () => {
      noHackMove(E.INCREASE_POWER_WITH_MORE_HP);
      // Hack: Wring Out has Brine's effect (see Brine), and Crush Grip is a binding move with no Expert routine.
      x({ moves: [M.WRING_OUT], effect: E.DOUBLE_POWER_WHEN_BELOW_HALF }, '0');
      x({ moves: [M.CRUSH_GRIP], effect: E.WHIRLPOOL }, '0');
    });
  });

  describe('Power Trick (Expert_PowerTrick, script.s:5442)', () => {
    const trick = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.POWER_TRICK], effect: E.SWAP_ATK_DEF, ...s });

    it('over 90% HP: 160/256 +1', () => {
      x(trick(), '160/256: +1, 96/256: 0');
      x(trick({ ai: { hp: hp(91) } }), '160/256: +1, 96/256: 0');
    });

    it('over 60%: 1/2 +1', () => {
      x(trick({ ai: { hp: hp(90) } }), HALF_PLUS_1);
      x(trick({ ai: { hp: hp(61) } }), HALF_PLUS_1);
    });

    it('over 30%: 92/256 +1', () => {
      x(trick({ ai: { hp: hp(60) } }), '92/256: +1, 164/256: 0'); // IfRandomLessThan 164
      x(trick({ ai: { hp: hp(31) } }), '92/256: +1, 164/256: 0');
    });

    it('note: 30% or less: -2', () => {
      // Gist error (omission): GoTo ScoreMinus2 (script.s:5451).
      x(trick({ ai: { hp: hp(30) } }), '-2');
    });
  });

  describe('Gastro Acid (Expert_GastroAcid, script.s:5471)', () => {
    const acid = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.GASTRO_ACID], effect: E.SUPRESS_ABILITY, ...s });
    // Gist error: past the 1/4 stop every branch starts with +1 (script.s:5482), so each of the gist's changes below is
    // one too low.

    it('1/4: nothing and end', () => {
      x(acid(), '192/256: +1, 64/256: 0');
    });

    it('the target over 70%: +1', () => {
      x(acid({ player: { hp: hp(71) } }), '192/256: +1, 64/256: 0');
    });

    it('70% or less: 1/2 +0, 1/2 -1', () => {
      x(acid({ player: { hp: hp(70) } }), '96/256: +1, 160/256: 0');
    });

    it('50% or less: 1/2 -1, 1/2 -2', () => {
      x(acid({ player: { hp: hp(50) } }), '160/256: 0, 96/256: -1');
    });

    it('30% or less: 1/2 -2, 1/2 -3', () => {
      x(acid({ player: { hp: hp(30) } }), '64/256: 0, 96/256: -1, 96/256: -2');
    });
  });

  describe('Lucky Chant (Expert_LuckyChant, script.s:5496)', () => {
    const chant = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.LUCKY_CHANT], effect: E.PREVENT_CRITS, ...s });

    it('under 70% HP: -1', () => {
      x(chant({ ai: { hp: hp(69) }, known: { moves: [M.SLASH] } }), '-1');
    });

    it('the target knows a high-crit move: +1', () => {
      x(chant({ known: { moves: [M.SLASH] } }), '+1');
      x(chant({ known: { moves: [M.BLAZE_KICK] } }), '+1');
      x(chant({ known: { moves: [M.CROSS_POISON] } }), '+1');
    });

    it('otherwise: 64/256 +1', () => {
      x(chant(), '64/256: +1, 192/256: 0');
      x(chant({ ai: { hp: hp(70) } }), '64/256: +1, 192/256: 0');
    });
  });

  describe('Me First (Expert_MeFirst, script.s:5519)', () => {
    // IfBattlerDealsMoreDamage compares the target's last move, estimated from the target into itself, with our best
    // estimate. With Me First alone ours is 0; Mega Kick beats the target's Tackle.
    const meFirst = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.ME_FIRST], effect: E.USE_MOVE_FIRST, ...s });
    const strong = (s: Partial<GistSetup> = {}): GistSetup => meFirst({ moves: [M.ME_FIRST, M.MEGA_KICK], ...s });

    it('slower: -2', () => {
      x(meFirst({ player: { prevMove: M.TACKLE } }), '-2');
    });

    it('the attacker deals more damage than the target: 224/256 +1', () => {
      // Gist error: it's the target that deals more (IfBattlerDealsMoreDamage AI_BATTLER_DEFENDER, script.s:5528).
      x(meFirst({ ai: { speed: FAST }, player: { prevMove: M.TACKLE } }), '21/64: +3, 10/64: +2, 29/64: +1, 4/64: 0');
      x(strong({ ai: { speed: FAST }, player: { prevMove: M.TACKLE } }), '3/8: +2, 1/8: +1, 1/2: 0');
    });

    it("the target's last move damaging: 1/2 +1", () => {
      // Gist error: the miss ends the routine, so it skips the 3/4 roll below (script.s:5538).
      x(strong({ ai: { speed: FAST }, player: { prevMove: M.TACKLE } }), '3/8: +2, 1/8: +1, 1/2: 0');
      x(strong({ ai: { speed: FAST } }), '3/8: +2, 1/8: +1, 1/2: 0'); // no last move: class Physical
    });

    it('then 192/256 +1', () => {
      x(strong({ ai: { speed: FAST }, player: { prevMove: M.GROWL } }), '192/256: +1, 64/256: 0');
    });
  });

  describe('Copycat (Expert_Copycat, script.s:5552)', () => {
    // As for Me First: with Copycat alone the target out-damages us; Mega Kick out-damages the target's Tackle.
    const copycat = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.COPYCAT], effect: E.USE_LAST_USED_MOVE, ...s });
    const strong = (s: Partial<GistSetup> = {}): GistSetup => copycat({ moves: [M.COPYCAT, M.MEGA_KICK], ...s });
    const LIKELY_MINUS_1 = '176/256: -1, 80/256: 0';

    it("slower, dealing less damage, and the target's last move not encouraged: 176/256 -1", () => {
      // Gist error: the -1 needs the target NOT to deal more (IfBattlerDealsMoreDamage ends it, script.s:5573).
      x(strong({ player: { prevMove: M.TACKLE } }), LIKELY_MINUS_1);
      x(strong(), LIKELY_MINUS_1);
      x(copycat({ player: { prevMove: M.TACKLE } }), '0');
      x(strong({ player: { prevMove: M.TOXIC } }), '0');
    });

    it('faster, dealing more damage: 224/256 +2', () => {
      // Gist error: again it's the target dealing more (script.s:5560).
      x(copycat({ ai: { speed: FAST }, player: { prevMove: M.TACKLE } }), '224/256: +2, 32/256: 0');
      // We deal more and Tackle isn't encouraged: the -1 roll instead.
      x(strong({ ai: { speed: FAST }, player: { prevMove: M.TACKLE } }), LIKELY_MINUS_1);
    });

    it("faster, the target's last move encouraged: 1/2 +2", () => {
      x(strong({ ai: { speed: FAST }, player: { prevMove: M.TOXIC } }), HALF_PLUS_2);
      x(strong({ ai: { speed: FAST }, player: { prevMove: M.TRICK } }), HALF_PLUS_2); // the table lists IDs: HP Psychic
      x(strong({ ai: { speed: FAST }, player: { prevMove: M.GROWL } }), LIKELY_MINUS_1);
    });
  });

  describe('Power Swap (Expert_PowerSwap, script.s:5632)', () => {
    const swap = (player: Partial<Record<StageName, number>>, ai: Partial<Record<StageName, number>> = {}): GistSetup => ({
      moves: [M.POWER_SWAP], effect: E.SWAP_ATK_SP_ATK_STAT_CHANGES, player: { stages: player }, ai: { stages: ai },
    });
    // The ladders: each step a coin, from the top change down to 0.
    const L5 = '16/32: +5, 8/32: +4, 4/32: +3, 2/32: +2, 1/32: +1, 1/32: 0';
    const L4 = '8/16: +4, 4/16: +3, 2/16: +2, 1/16: +1, 1/16: 0';
    const L3 = '4/8: +3, 2/8: +2, 1/8: +1, 1/8: 0';
    const L2 = '2/4: +2, 1/4: +1, 1/4: 0';
    const L1 = '1/2: +1, 1/2: 0';

    it('Attack difference over 3: Sp. Atk over 3 → +5 ladder, over 1 → +4, 0 → +3, else nothing', () => {
      x(swap({ attack: 4, spAttack: 4 }), L5);
      x(swap({ attack: 4, spAttack: 2 }), L4);
      x(swap({ attack: 4 }), L3);
      x(swap({ attack: 4, spAttack: 1 }), '0');
      x(swap({ attack: 4, spAttack: -1 }), '0');
    });

    it('over 1: Sp. Atk over 3 → +4, over 1 → +3, 0 → +2, else nothing', () => {
      x(swap({ attack: 2, spAttack: 4 }), L4);
      x(swap({ attack: 3, spAttack: 3 }), L3);
      x(swap({ attack: 2 }), L2);
      x(swap({ attack: 2, spAttack: 1 }), '0');
    });

    it('over 0: Sp. Atk over 3 → +3, over 1 → +2, 0 → +1, else nothing', () => {
      x(swap({ attack: 1, spAttack: 4 }), L3);
      x(swap({ attack: 1, spAttack: 2 }), L2);
      x(swap({ attack: 1 }), L1);
      x(swap({ attack: 1, spAttack: 1 }), '0');
    });

    it('0: Sp. Atk over 3 → +3, over 1 → +2, over 0 → +1, else nothing', () => {
      x(swap({ spAttack: 4 }), L3);
      x(swap({ spAttack: 2 }), L2);
      x(swap({ spAttack: 1 }), L1);
      x(swap({}), '0');
      x(swap({ attack: -1, spAttack: 4 }), '0'); // a negative Attack difference: nothing
    });

    it("note: the difference is the target's stage less ours (DiffStatStages, trainer_ai.c:2267)", () => {
      x(swap({}, { attack: -4, spAttack: -4 }), L5);
      x(swap({ attack: 6, spAttack: 6 }, { attack: 2, spAttack: 2 }), L5);
    });
  });

  describe('Guard Swap (Expert_GuardSwap, script.s:5766)', () => {
    const swap = (player: Partial<Record<StageName, number>>): GistSetup => ({
      moves: [M.GUARD_SWAP], effect: E.SWAP_DEF_SP_DEF_STAT_CHANGES, player: { stages: player },
    });

    it('Defense difference over 3: Sp. Def over 3 → +5 ladder, over 1 → +4, 0 → +3, else nothing', () => {
      x(swap({ defense: 4, spDefense: 4 }), '16/32: +5, 8/32: +4, 4/32: +3, 2/32: +2, 1/32: +1, 1/32: 0');
      x(swap({ defense: 4, spDefense: 3 }), '8/16: +4, 4/16: +3, 2/16: +2, 1/16: +1, 1/16: 0');
      x(swap({ defense: 4 }), '4/8: +3, 2/8: +2, 1/8: +1, 1/8: 0');
      x(swap({ defense: 4, spDefense: 1 }), '0');
    });

    it('over 1: Sp. Def over 3 → +4, over 1 → +3, 0 → +2', () => {
      x(swap({ defense: 2, spDefense: 4 }), '8/16: +4, 4/16: +3, 2/16: +2, 1/16: +1, 1/16: 0');
      x(swap({ defense: 2, spDefense: 2 }), '4/8: +3, 2/8: +2, 1/8: +1, 1/8: 0');
      x(swap({ defense: 2 }), '2/4: +2, 1/4: +1, 1/4: 0');
    });

    it('over 0: Sp. Def over 3 → +3, over 1 → +2, 0 → +1', () => {
      x(swap({ defense: 1, spDefense: 4 }), '4/8: +3, 2/8: +2, 1/8: +1, 1/8: 0');
      x(swap({ defense: 1, spDefense: 2 }), '2/4: +2, 1/4: +1, 1/4: 0');
      x(swap({ defense: 1 }), HALF_PLUS_1);
    });

    it('0: Sp. Def over 3 → +3, over 1 → +2, over 0 → +1, else nothing', () => {
      x(swap({ spDefense: 4 }), '4/8: +3, 2/8: +2, 1/8: +1, 1/8: 0');
      x(swap({ spDefense: 2 }), '2/4: +2, 1/4: +1, 1/4: 0');
      x(swap({ spDefense: 1 }), HALF_PLUS_1);
      x(swap({}), '0');
    });
  });

  describe('Punishment (Expert_Punishment, script.s:5900)', () => {
    const punish = (stages: Partial<Record<StageName, number>>, s: Partial<GistSetup> = {}): GistSetup => ({
      moves: [M.PUNISHMENT], effect: E.INCREASE_POWER_WITH_MORE_STAT_UP, ...s, player: { stages, ...s.player },
    });
    // Gist error: the ladder's steps don't end the routine; each falls into the next (script.s:5934–5948), so it's +4, +3,
    // +2 and +1 on four independent coins.

    it('resisted or immune: nothing', () => {
      x(punish({ attack: 6 }, { player: { types: dark } }), '0');
    });

    it('positive stages over 6: +4 ladder', () => {
      x(punish({ attack: 6, defense: 1 }),
        '1/16: +10, 1/16: +9, 1/16: +8, 2/16: +7, 2/16: +6, 2/16: +5, 2/16: +4, 2/16: +3, 1/16: +2, 1/16: +1, 1/16: 0');
    });

    it('exactly 6: +3 ladder', () => {
      x(punish({ attack: 6 }), '1/8: +6, 1/8: +5, 1/8: +4, 2/8: +3, 1/8: +2, 1/8: +1, 1/8: 0');
    });

    it('exactly 5: +2 ladder', () => {
      x(punish({ attack: 3, evasion: 2 }), '1/4: +3, 1/4: +2, 1/4: +1, 1/4: 0');
    });

    it('over 2: 1/2 +1', () => {
      x(punish({ attack: 3 }), HALF_PLUS_1);
      x(punish({ attack: 2, accuracy: 2 }), HALF_PLUS_1); // accuracy and evasion count
    });

    it('otherwise: nothing', () => {
      x(punish({}), '0');
      x(punish({ attack: 2 }), '0');
      x(punish({ attack: -2, defense: 2 }), '0'); // only positive stages are summed
    });
  });

  describe('Last Resort (Expert_LastResort, script.s:5953)', () => {
    it('resisted or immune: -1', () => {
      x({ moves: [M.LAST_RESORT, M.TACKLE], effect: E.FAIL_IF_NOT_USED_ALL_OTHER_MOVES, player: { types: ghost }, ai: { effects: { lastResortCount: 1 } } }, '-1');
    });

    it('can use Last Resort: +1; else nothing', () => {
      x({ moves: [M.LAST_RESORT, M.TACKLE], ai: { effects: { lastResortCount: 1 } } }, '+1');
      x({ moves: [M.LAST_RESORT, M.TACKLE] }, '0');
      x({ moves: [M.LAST_RESORT], ai: { effects: { lastResortCount: 1 } } }, '0'); // its only move
    });
  });

  describe('Worry Seed (Expert_WorrySeed, script.s:5973)', () => {
    const seed = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.WORRY_SEED], effect: E.SET_ABILITY_TO_INSOMNIA, ...s });

    it('the target knows Rest: +1', () => {
      x(seed({ ai: { hp: hp(49) }, known: { moves: [M.REST] } }), '192/256: +2, 64/256: +1');
    });

    it('50% HP or more: 1/2 +1', () => {
      x(seed(), '96/256: +2, 128/256: +1, 32/256: 0');
      x(seed({ ai: { hp: hp(50) } }), '96/256: +2, 128/256: +1, 32/256: 0');
    });

    it('then 192/256 +1', () => {
      x(seed({ ai: { hp: hp(49) } }), '192/256: +1, 64/256: 0');
    });
  });

  describe('Sucker Punch (Expert_SuckerPunch, script.s:5995)', () => {
    it('resisted -1; else 192/256 +1: no move has the effect', () => {
      noHackMove(E.HIT_FIRST_IF_TARGET_ATTACKING);
      x({ moves: [M.SUCKER_PUNCH], effect: E.HIT }, '0'); // Hack: a plain priority hit
    });
  });

  describe('Toxic Spikes (Expert_ToxicSpikes, script.s:6012)', () => {
    it('1/2 nothing and end; else +1', () => {
      x({ moves: [M.TOXIC_SPIKES], effect: E.TOXIC_SPIKES }, HALF_PLUS_1);
    });

    it('knows Roar or Whirlwind: 192/256 +1 more', () => {
      x({ moves: [M.TOXIC_SPIKES, M.ROAR] }, '96/256: +2, 32/256: +1, 128/256: 0');
      x({ moves: [M.TOXIC_SPIKES, M.WHIRLWIND] }, '96/256: +2, 32/256: +1, 128/256: 0');
    });
  });

  describe('Heart Swap (Expert_HeartSwap, script.s:6031)', () => {
    it('the target boosted -2 or our stages +1/+2 or 206/256 -2: no move has the effect', () => {
      noHackMove(E.SWAP_STAT_CHANGES);
      // Hack: Heart Swap is a Water drain move (see Draining attacks).
      x({ moves: [M.HEART_SWAP], effect: E.RECOVER_HALF_DAMAGE_DEALT, player: { stages: { attack: 3 } } }, '0');
    });
  });

  describe('Aqua Ring (Expert_AquaRing, script.s:6081)', () => {
    it('30% HP or more: 1/2 +1', () => {
      x({ moves: [M.AQUA_RING], effect: E.RESTORE_HP_EVERY_TURN }, HALF_PLUS_1);
      x({ moves: [M.AQUA_RING], ai: { hp: hp(30) } }, HALF_PLUS_1);
      x({ moves: [M.AQUA_RING], ai: { hp: hp(29) } }, '0');
    });
  });

  describe('Magnet Rise (Expert_MagnetRise, script.s:6090)', () => {
    const rise = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.MAGNET_RISE], effect: E.GIVE_GROUND_IMMUNITY, ...s });

    it('under 50% HP: nothing more', () => {
      x(rise({ ai: { hp: hp(49) }, known: { moves: [M.EARTHQUAKE] }, player: { types: [TYPE_GROUND, TYPE_GROUND] } }), '0');
    });

    it('the target knows Earthquake, Earth Power or Fissure: +1', () => {
      x(rise({ known: { moves: [M.EARTHQUAKE] } }), '1/2: +2, 1/2: +1');
      x(rise({ known: { moves: [M.EARTH_POWER] } }), '1/2: +2, 1/2: +1');
      x(rise({ known: { moves: [M.FISSURE] } }), '1/2: +2, 1/2: +1');
    });

    it('a Ground target: +1; otherwise 1/2 +1', () => {
      x(rise(), HALF_PLUS_1);
      x(rise({ ai: { hp: hp(50) } }), HALF_PLUS_1);
      x(rise({ player: { types: [TYPE_NORMAL, TYPE_GROUND] } }), '+1');
      x(rise({ player: { types: [TYPE_GROUND, TYPE_GROUND] }, known: { moves: [M.EARTHQUAKE] } }), '+2');
    });
  });

  describe('Defog (Expert_Defog, script.s:6125)', () => {
    const defog = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.DEFOG], effect: E.REMOVE_HAZARDS_SCREENS_EVA_DOWN, ...s });
    const LIKELY_MINUS_2 = '206/256: -2, 50/256: 0';

    it('screens up, the attacker under 30% and its last Pokémon: 206/256 -2; the target over 70% -2', () => {
      // Gist error: "under 30%" is 30% or less (IfHPPercentGreaterThan 30, script.s:6153), and the -2 is for a target
      // at 70% or LESS (:6184): the roll jumps into the final block.
      x(defog({ sides: [SIDE_CONDITION_REFLECT, 0], ai: { hp: hp(30) }, aiBench: 0 }), LIKELY_MINUS_2);
      x(defog({ sides: [SIDE_CONDITION_REFLECT, 0], ai: { hp: hp(30) }, aiBench: 0, player: { hp: hp(70) } }), '206/256: -4, 50/256: -2');
    });

    it('screens up: otherwise +1', () => {
      x(defog({ sides: [SIDE_CONDITION_REFLECT, 0] }), '+1');
      x(defog({ sides: [SIDE_CONDITION_LIGHT_SCREEN, 0] }), '+1');
      x(defog({ sides: [SIDE_CONDITION_REFLECT, 0], ai: { hp: hp(31) }, aiBench: 0 }), '206/256: -1, 50/256: +1');
      x(defog({ sides: [SIDE_CONDITION_REFLECT, 0], ai: { hp: hp(30) } }), '206/256: -1, 50/256: +1'); // a Pokémon to spare
      x(defog({ sides: [0, SIDE_CONDITION_REFLECT] }), '0'); // our own side doesn't count
    });

    it('screens up: the target with a Pokémon left and hazards: 1/2 -1', () => {
      x(defog({ sides: [SIDE_CONDITION_REFLECT | SIDE_CONDITION_SPIKES, 0] }), '1/2: +1, 1/2: 0');
      // The target's last Pokémon ends the routine after the +1, before the final block (:6159–6160).
      x(defog({ sides: [SIDE_CONDITION_REFLECT | SIDE_CONDITION_SPIKES, 0], playerBench: 0, player: { hp: hp(10) } }), '+1');
    });

    it('hazards on the target side: -2', () => {
      x(defog({ sides: [SIDE_CONDITION_SPIKES, 0] }), '-2');
      x(defog({ sides: [SIDE_CONDITION_STEALTH_ROCK, 0] }), '-2');
      x(defog({ sides: [SIDE_CONDITION_TOXIC_SPIKES, 0] }), '-2');
    });

    it('the attacker at 70% or more, the target evasion at -2 or more and the target at 70% or less: -2', () => {
      x(defog(), '0');
      x(defog({ player: { hp: hp(70) } }), '-2');
      x(defog({ player: { hp: hp(71) } }), '0');
    });

    it('otherwise: 206/256 -2, and -2 more with the target at 70% or less', () => {
      x(defog({ ai: { hp: hp(69) } }), LIKELY_MINUS_2);
      x(defog({ player: { stages: { evasion: -3 } } }), LIKELY_MINUS_2);
      x(defog({ ai: { hp: hp(69) }, player: { hp: hp(70) } }), '206/256: -4, 50/256: -2');
    });
  });

  describe('Trick Room (Expert_TrickRoom, script.s:6190)', () => {
    const room = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.TRICK_ROOM], effect: E.TRICK_ROOM, ...s });
    const LIKELY_PLUS_3 = '192/256: +3, 64/256: 0';

    it('a double battle: nothing (singles only here)', () => {
      // No singles battle path reaches this rule (IfLoadedMask BATTLE_TYPE_DOUBLES, script.s:6199): this pins singles.
      x(room(), LIKELY_PLUS_3);
    });

    it('30% HP or less and the last Pokémon: nothing', () => {
      x(room({ ai: { hp: hp(30) }, aiBench: 0 }), '0');
      x(room({ ai: { hp: hp(30), speed: FAST }, aiBench: 0 }), '0');
      x(room({ ai: { hp: hp(30) } }), LIKELY_PLUS_3);
      x(room({ ai: { hp: hp(31) }, aiBench: 0 }), LIKELY_PLUS_3);
    });

    it('faster: -1', () => {
      x(room({ ai: { speed: FAST } }), '-1');
      x(room({ ai: { speed: TIE } }), '-1'); // a tie isn't slower
    });

    it('slower: 192/256 +3', () => {
      x(room(), LIKELY_PLUS_3);
    });
  });

  describe('Blizzard (Expert_Blizzard, script.s:6216)', () => {
    it('resisted or immune: 206/256 -3', () => {
      x({ moves: [M.BLIZZARD], effect: E.BLIZZARD, player: { types: [TYPE_WATER, TYPE_WATER] } }, '206/256: -3, 50/256: 0');
      x({ moves: [M.BLIZZARD], player: { types: [TYPE_FIRE, TYPE_FIRE] }, field: FIELD_CONDITION_HAILING_PERM }, '206/256: -3, 50/256: 0');
    });

    it('hail: +1', () => {
      x({ moves: [M.BLIZZARD] }, '0');
      x({ moves: [M.BLIZZARD], field: FIELD_CONDITION_HAILING_PERM }, '+1');
      // Hack: Ice Ball and Sheer Cold have Blizzard's effect.
      x({ moves: [M.ICE_BALL], effect: E.BLIZZARD, field: FIELD_CONDITION_HAILING_PERM }, '+1');
      x({ moves: [M.SHEER_COLD], effect: E.BLIZZARD, field: FIELD_CONDITION_HAILING_PERM }, '+1');
      x({ moves: [M.THUNDER], effect: E.THUNDER, field: FIELD_CONDITION_RAINING_PERM }, '0'); // Expert_Thunder is never reached (script.s:1718–1719)
    });
  });

  describe('Captivate (Expert_Captivate, script.s:6236)', () => {
    const captivate = (s: Partial<GistSetup> = {}): GistSetup => ({ moves: [M.CAPTIVATE], effect: E.SP_ATK_DOWN_2_OPPOSITE_GENDER, ...s });
    /** A Special last move, so the Physical roll at the end stays out. */
    const special = (player: GistSetup['player'] = {}): GistSetup['player'] => ({ prevMove: M.THUNDERBOLT, ...player });

    it('target Sp. Atk not at +0: -1', () => {
      x(captivate({ player: special() }), '0');
      x(captivate({ player: special({ stages: { spAttack: -1 } }) }), '-1');
      x(captivate({ player: special({ stages: { spAttack: 1 } }) }), '-1');
    });

    it('...and the attacker at 90% or less: -1 more', () => {
      x(captivate({ ai: { hp: hp(90) }, player: special({ stages: { spAttack: -1 } }) }), '-2');
      x(captivate({ ai: { hp: hp(90) }, player: special() }), '0');
    });

    it('...and the target at -3 or less: 206/256 -2 more', () => {
      x(captivate({ player: special({ stages: { spAttack: -3 } }) }), '206/256: -3, 50/256: -1');
    });

    it('the target at 70% or less: -2', () => {
      x(captivate({ player: special({ hp: hp(70) }) }), '-2');
      x(captivate({ player: special({ hp: hp(71) }) }), '0');
    });

    it("the target's last move Physical: 192/256 -1", () => {
      x(captivate({ player: { prevMove: M.TACKLE } }), '192/256: -1, 64/256: 0');
      x(captivate(), '192/256: -1, 64/256: 0'); // no last move: class Physical
      x(captivate({ player: { prevMove: M.GROWL } }), '0');
    });
  });

  describe('Stealth Rock (Expert_StealthRock, script.s:6268)', () => {
    it('1/2 nothing and end; else +1', () => {
      x({ moves: [M.STEALTH_ROCK], effect: E.STEALTH_ROCK }, HALF_PLUS_1);
    });

    it('knows Roar or Whirlwind: 192/256 +1 more', () => {
      x({ moves: [M.STEALTH_ROCK, M.ROAR] }, '96/256: +2, 32/256: +1, 128/256: 0');
      x({ moves: [M.STEALTH_ROCK, M.WHIRLWIND] }, '96/256: +2, 32/256: +1, 128/256: 0');
    });
  });
});
