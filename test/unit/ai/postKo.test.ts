// BattleAI_PostKOSwitchIn (battle_lib.c:7923) and the replacement fallback (battle_display.c:4543–4559), singles: the
// AI's Garchomp (party 0: Atk 150, SpA 100, level 50) has just fainted, facing Luxray (Def 99, SpD 99, Electric).
// Stage 1 scores types (battle_lib.c:3009) and needs a super-effective move; stage 2 scores damage as Garchomp (:6601).

import { describe, expect, it } from 'vitest';
import { postKoSwitchIn, replacement } from '../../../src/ai/choose/postKo.js';
import {
  BATTLE_TYPE_TRAINER_DOUBLES, TYPE_DRAGON, TYPE_ELECTRIC, TYPE_FIGHTING, TYPE_FLYING, TYPE_GRASS, TYPE_GROUND,
  TYPE_NORMAL, TYPE_POISON, TYPE_ROCK, TYPE_STEEL, TYPE_WATER,
} from '../../../src/ai/constants.js';
import { AI_BATTLER as AI, type AiBattleMon, type AiPartyMon, type AiView, PLAYER_BATTLER as PLAYER } from '../../../src/ai/view.js';
import { FX, fixtureDeps, fixtureView } from './fixtures.js';
import { code, frozen } from './miscHarness.js';

const M = FX.move;
const S = FX.species;
/** SPECIES_MACHAMP (generated/species.txt); the AI reads only that it is a Pokémon. */
const MACHAMP = 68;

/** A level-50 bench Pokémon with `moves` (the rest empty), no ability or item; `hp` 0 makes it fainted. */
function member(species: number, types: [number, number], moves: number[], hp = 100): AiPartyMon {
  const slots = [...moves, 0, 0, 0, 0].slice(0, 4);
  return {
    species, form: 0, level: 50, hp, maxHp: 100, status: 0, moves: slots, pp: slots.map((m) => (m ? 10 : 0)),
    ppMax: slots.map((m) => (m ? 10 : 0)), heldItem: 0, ability: 0, types, ivs: { hp: 30, atk: 30, def: 30, spa: 30, spd: 30, spe: 30 },
  };
}
const gyarados = (...moves: number[]) => member(S.GYARADOS, [TYPE_WATER, TYPE_FLYING], moves);
const roserade = (...moves: number[]) => member(S.ROSERADE, [TYPE_GRASS, TYPE_POISON], moves);

/** Garchomp fainted, with `bench` as party 1 onwards, `garchomp` patched in and Luxray's types replaced. */
function faintedView(bench: AiPartyMon[], garchomp: Partial<AiBattleMon> = {}, playerTypes?: [number, number]): AiView {
  const v = fixtureView();
  Object.assign(v.mons[AI], { curHP: 0, ...garchomp });
  if (playerTypes) v.mons[PLAYER].types = playerTypes;
  v.parties[1] = [{ ...v.parties[1][0]!, hp: 0 }, ...bench];
  return v;
}

const ROCK_STEEL: [number, number] = [TYPE_ROCK, TYPE_STEEL];

describe('postKoSwitchIn', () => {
  it.each<[string, AiPartyMon[], Partial<AiBattleMon>, [number, number] | undefined, number]>([
    // Party 1 scores 20 + 20 = 40, party 2 40 + 80 = 120 but has no super-effective move (:8020–8021), party 3 40 + 20.
    ['stage 1 needs a super-effective move', [
      member(S.LUXRAY, [TYPE_ELECTRIC, TYPE_ELECTRIC], [M.SPARK, M.MAGNITUDE]),
      member(S.GARCHOMP, [TYPE_DRAGON, TYPE_GROUND], [M.DRAGON_CLAW, M.CRUNCH, M.FIRE_FANG]),
      gyarados(M.WATERFALL, M.ICE_FANG, M.EARTHQUAKE),
    ], {}, undefined, 3],
    // Fighting/Fighting into Rock/Steel: 160 counted twice is 320 in the u8 `score` (:7933, 7980–7981), so 64 < 90.
    ['stage 1 u8 overflow (docs/bugs_and_glitches.md)', [member(MACHAMP, [TYPE_FIGHTING, TYPE_FIGHTING], [M.SEISMIC_TOSS]), gyarados(M.WATERFALL)],
      {}, ROCK_STEEL, 2],
    ['stage 1 without overflow: Fighting/Normal scores 170', [member(MACHAMP, [TYPE_FIGHTING, TYPE_NORMAL], [M.SEISMIC_TOSS]), gyarados(M.WATERFALL)],
      {}, ROCK_STEEL, 1],
    // Stage 2 scores as the fainted battler (:8054–8063): Waterfall 150 * 80 * 22 / 99 / 50 + 2 = 55, Energy Ball 37.
    ["stage 2 uses the fainted battler's Attack", [roserade(M.ENERGY_BALL), gyarados(M.WATERFALL)], {}, undefined, 2],
    ["stage 2 uses the fainted battler's Sp. Atk", [roserade(M.ENERGY_BALL), gyarados(M.WATERFALL)], { attack: 100, spAttack: 150 }, undefined, 1],
    // Stage 1's last `score` is party 1's 60. Stage 2 skips Seismic Toss (power 1, :8053) but still compares that stale
    // 60 (:8080): Waterfall's 55 doesn't beat it, but at Atk 200 its 73 does.
    ['stage 2 keeps a stale score across a skipped move', [gyarados(M.SEISMIC_TOSS), roserade(M.WATERFALL)], {}, undefined, 1],
    ['stage 2 beats the stale score', [gyarados(M.SEISMIC_TOSS), roserade(M.WATERFALL)], { attack: 200 }, undefined, 2],
  ])('%s', (_, bench, garchomp, playerTypes, expected) => {
    const v = faintedView(bench, garchomp, playerTypes);
    expect(postKoSwitchIn(frozen(v), fixtureDeps(), AI)).toBe(expected);
    expect(replacement(v, fixtureDeps())).toBe(expected);
  });

  it('falls back to the first living unselected slot when both stages leave 6 (battle_display.c:4551–4557)', () => {
    // Against Ground, Electric scores 0 in stage 1 and its moves are immune in stage 2 (battle_lib.c:8075–8077).
    const v = faintedView([
      member(S.GYARADOS, [TYPE_WATER, TYPE_FLYING], [M.WATERFALL], 0),
      member(S.LUXRAY, [TYPE_ELECTRIC, TYPE_ELECTRIC], [M.SPARK]),
      member(S.LUXRAY, [TYPE_ELECTRIC, TYPE_ELECTRIC], [M.THUNDER_FANG]),
    ], {}, [TYPE_GROUND, TYPE_GROUND]);
    expect(postKoSwitchIn(frozen(v), fixtureDeps(), AI)).toBe(6);
    expect(replacement(v, fixtureDeps())).toBe(2);
  });

  it("reads no speed: an unknown or known Quick Claw draw doesn't change the pick", () => {
    // Neither stage nor the fallback reads speedRand or BattleSystem_CompareBattlerSpeed (battle_lib.c:7923–8089).
    const picks = [null, true, false].map((draw) => {
      const v = faintedView([member(S.LUXRAY, [TYPE_ELECTRIC, TYPE_ELECTRIC], [M.SPARK]), gyarados(M.WATERFALL, M.EARTHQUAKE)]);
      v.mons[AI].heldItem = FX.item.QUICK_CLAW;
      v.mons[PLAYER].heldItem = FX.item.QUICK_CLAW;
      v.parties[1] = v.parties[1].map((mon) => ({ ...mon, heldItem: FX.item.QUICK_CLAW }));
      v.quickClawThisTurn = [draw, draw, null, null];
      return replacement(frozen(v), fixtureDeps());
    });
    expect(picks).toEqual([2, 2, 2]);
  });

  it('doubles are unsupported', () => {
    const v = fixtureView({ battleType: BATTLE_TYPE_TRAINER_DOUBLES });
    expect(() => postKoSwitchIn(v, fixtureDeps(), AI)).toThrow(code('UNSUPPORTED'));
    expect(() => replacement(v, fixtureDeps())).toThrow(code('UNSUPPORTED'));
  });
});
