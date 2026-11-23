// TrainerAI_PickCommand (trainer_ai.c:3989–4040), singles: switch, else item, else fight, on the fixture's turn-1 view
// (Luxray against Garchomp, Gyarados and Roserade on the bench, a Full Restore and a Hyper Potion in the bag). Under the
// empty script every move ties at 100 and splits evenly. The four parts are spied on, each calling the real function.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rational } from '../../../src/contracts/engine.js';
import { type ActionDist, decide } from '../../../src/ai/choose/decide.js';
import { shouldUseItem } from '../../../src/ai/choose/items.js';
import { moveDistribution } from '../../../src/ai/choose/moves.js';
import { replacement } from '../../../src/ai/choose/postKo.js';
import { shouldSwitch } from '../../../src/ai/choose/switch.js';
import {
  ABILITY_NATURAL_CURE, ABILITY_WATER_ABSORB, BATTLE_TYPE_ROAMER, BATTLE_TYPE_TRAINER_DOUBLES,
  ITEM_AI_CATEGORY_FULL_RESTORE, MON_CONDITION_BURN, MON_CONDITION_FREEZE, MON_CONDITION_NONE, MON_CONDITION_PARALYSIS,
  MON_CONDITION_POISON, MON_CONDITION_SLEEP_1, MON_CONDITION_TOXIC, SPECIES_EGG, TYPE_GHOST,
} from '../../../src/ai/constants.js';
import { ONE, rat, sum } from '../../../src/ai/odds.js';
import { AI_BATTLER as AI, type AiDeps, type AiView, PLAYER_BATTLER as PLAYER } from '../../../src/ai/view.js';
import { emptyKnowledge, FX, fixtureDeps, fixtureView } from './fixtures.js';
import {
  code, frozen, hitBy, immuneSwitchView, NO_SUPER_EFFECTIVE, naturalCureView, switchOdds,
} from './miscHarness.js';

const { spyOn } = vi.hoisted(() => ({
  /** The module with `name` wrapped in a spy that calls the real function. */
  spyOn: async (load: () => Promise<Record<string, unknown>>, name: string) => {
    const real = await load();
    return { ...real, [name]: vi.fn(real[name] as (...args: unknown[]) => unknown) };
  },
}));
vi.mock('../../../src/ai/choose/switch.js', (load) => spyOn(load, 'shouldSwitch'));
vi.mock('../../../src/ai/choose/postKo.js', (load) => spyOn(load, 'replacement'));
vi.mock('../../../src/ai/choose/items.js', (load) => spyOn(load, 'shouldUseItem'));
vi.mock('../../../src/ai/choose/moves.js', (load) => spyOn(load, 'moveDistribution'));

// mockReset drops one-off return values and restores the real function passed to vi.fn.
beforeEach(() => {
  for (const fn of [shouldSwitch, replacement, shouldUseItem, moveDistribution]) vi.mocked(fn).mockReset();
});

const M = FX.move;
const I = FX.item;
const KIND_ORDER = { switch: 0, item: 1, move: 2 } as const;

/**
 * decide on `v` (frozen) with what the AI knows at battle start, after checking the result's shape: it sums to ONE,
 * every probability is above 0, and each action appears once, switches by party index, then the item, then moves by slot.
 */
function run(v: AiView, d: AiDeps = fixtureDeps()): ActionDist[] {
  const dist = decide(frozen(v), d, emptyKnowledge());
  expect(sum(dist.map((entry) => entry.probability))).toEqual(ONE);
  expect(dist.every((entry) => entry.probability.num > 0n)).toBe(true);
  const order = dist.map(({ action }) => KIND_ORDER[action.kind] * 10 + (action.kind === 'switch' ? action.partyIndex
    : action.kind === 'move' ? action.slot : 0));
  expect(order).toEqual([...new Set(order)].sort((a, b) => a - b));
  return dist;
}

const sw = (partyIndex: number, probability: Rational): ActionDist => ({ action: { kind: 'switch', partyIndex }, probability });
const mv = (slot: number, probability: Rational): ActionDist => ({ action: { kind: 'move', slot }, probability });
/** Each of the four move slots at `p`. */
const fourMoves = (p: Rational) => [0, 1, 2, 3].map((slot) => mv(slot, p));

describe('decide', () => {
  it('stays without an item: the move distribution', () => {
    // Earthquake keeps Garchomp in (trainer_ai.c:3964); the Full Restore needs HP under a quarter (:4100).
    expect(run(fixtureView())).toEqual(fourMoves(rat(1, 4)));
  });

  it('an item beats the moves', () => {
    // The immune switch at 3/4; otherwise Garchomp at 44/183 uses the Full Restore (:4099–4104, 4034–4035).
    const v = immuneSwitchView();
    v.mons[AI].curHP = 44;
    expect(run(v)).toEqual([
      sw(1, rat(3, 4)),
      { action: { kind: 'item', item: I.FULL_RESTORE, type: ITEM_AI_CATEGORY_FULL_RESTORE, condition: 0, consumed: [0] }, probability: rat(1, 4) },
    ]);
  });

  it('sums to one over a grid that reaches every kind of command', () => {
    // Three switch set-ups, HP 100/30/10%, each major status, with and without the bench, and three items in the bag.
    const statuses = [
      MON_CONDITION_NONE, MON_CONDITION_SLEEP_1, MON_CONDITION_POISON, MON_CONDITION_BURN, MON_CONDITION_FREEZE,
      MON_CONDITION_PARALYSIS, MON_CONDITION_TOXIC,
    ];
    const kinds = new Set<string>();
    const cells = [100, 30, 10].flatMap((percent) => statuses.flatMap((status) => [true, false].map((bench) => ({ percent, status, bench }))));
    for (const setup of [fixtureView, immuneSwitchView, naturalCureView]) {
      for (const { percent, status, bench } of cells) {
        const v = setup();
        Object.assign(v, { trainerItems: [I.FULL_HEAL, I.FULL_RESTORE, I.HYPER_POTION, 0], trainerItemCount: 3 });
        Object.assign(v.mons[AI], { curHP: Math.trunc((v.mons[AI].maxHP * percent) / 100), status });
        if (!bench) for (const member of v.parties[1].slice(1)) member.hp = 0;
        for (const { action } of run(v)) kinds.add(action.kind);
      }
    }
    expect([...kinds].sort()).toEqual(['item', 'move', 'switch']);
  });

  it('merges one switch reached through two rolls into one action', () => {
    // Water Gun hit an asleep Natural Cure Garchomp; Gyarados (party 1) has Water Absorb. The absorb coin switches to it
    // at 1/2 (trainer_ai.c:3706); otherwise Natural Cure's last coin (:3853) reaches the post-KO logic at 1/4, which also
    // picks Gyarados (Waterfall does the most damage), so switch 1 at 3/4. Staying fights: four moves at 1/16.
    const v = hitBy(M.WATER_GUN);
    Object.assign(v.mons[AI], { moves: [...NO_SUPER_EFFECTIVE], ability: ABILITY_NATURAL_CURE, status: MON_CONDITION_SLEEP_1 });
    v.parties[1][1]!.ability = ABILITY_WATER_ABSORB;
    expect(switchOdds(v)).toEqual({ 'switch 1': rat(1, 2), postKo: rat(1, 4), stay: rat(1, 4) });
    expect(run(v)).toEqual([sw(1, rat(3, 4)), ...fourMoves(rat(1, 16))]);
  });

  it('switches come by party index, whatever order the rolls reach them', () => {
    // Luxray made Ghost, so Tackle and Hyper Beam are ineffective (trainer_ai.c:3385–3415). The super-effective pass
    // (:3431–3484) draws `% 3 < 2` twice for Roserade's Crunch: switch 2 at 1 − q², q = 21845/65536. The neutral pass
    // (:3490–3543) draws `% 2 == 0` twice for Gyarados's Waterfall: switch 1 at q² · 3/4. Staying, the two moves tie.
    const v = fixtureView();
    v.mons[PLAYER].types = [TYPE_GHOST, TYPE_GHOST];
    v.mons[AI].moves = [M.TACKLE, M.HYPER_BEAM, 0, 0];
    v.parties[1][1]!.moves = [M.WATERFALL, M.PROTECT, 0, 0];
    v.parties[1][2]!.moves = [M.CRUNCH, 0, 0, 0];
    const fails = 21845n ** 2n;
    const all = 65536n ** 2n;
    expect(Object.keys(switchOdds(v))).toEqual(['switch 2', 'switch 1', 'stay']);
    expect(run(v)).toEqual([
      sw(1, rat(fails * 3n, all * 4n)), sw(2, rat(all - fails, all)), mv(0, rat(fails, all * 8n)), mv(1, rat(fails, all * 8n)),
    ]);
  });

  it('the post-KO logic runs with aiSwitchedPartySlot 6', () => {
    // TrainerAI_ShouldSwitch writes aiSwitchedPartySlot[battler] = 6 (trainer_ai.c:3829, 3836, 3854) before
    // BattleAI_PostKOSwitchIn reads it (battle_lib.c:7973–7974). A slot naming Gyarados (party 1) keeps it off the
    // voluntary bench count (party 3, a second Gyarados, is counted), but not off the replacement.
    const v = naturalCureView();
    v.aiSwitchedPartySlot = [6, 1, 6, 6];
    v.parties[1][2]!.hp = 0;
    v.parties[1].push({ ...v.parties[1][1]!, species: FX.species.GYARADOS });
    expect(switchOdds(v)).toEqual({ postKo: rat(7, 8), stay: rat(1, 8) });
    // Both Gyarados score alike, and the first of equal scores wins (battle_lib.c:8080–8083).
    expect(run(v)[0]).toEqual(sw(1, rat(7, 8)));
    expect(vi.mocked(replacement).mock.calls[0]![0].aiSwitchedPartySlot).toEqual([6, 6, 6, 6]);
  });

  it('a certain switch never reaches the item check or the moves (trainer_ai.c:4030)', () => {
    // Natural Cure after a damaging hit: Gyarados is immune to Earthquake and has it, so the immune pass switches at 1.
    const v = hitBy(M.EARTHQUAKE);
    Object.assign(v.mons[AI], { moves: [...NO_SUPER_EFFECTIVE], ability: ABILITY_NATURAL_CURE, status: MON_CONDITION_SLEEP_1 });
    v.parties[1][1]!.moves = [M.WATERFALL, M.EARTHQUAKE, M.ICE_FANG, M.PROTECT];
    expect(run(v)).toEqual([sw(1, ONE)]);
    expect(vi.mocked(shouldUseItem)).not.toHaveBeenCalled();
    expect(vi.mocked(moveDistribution)).not.toHaveBeenCalled();
  });

  it('a roamer only fights, even with a switch and an item available (trainer_ai.c:4000)', () => {
    const v = immuneSwitchView();
    v.battleType = BATTLE_TYPE_ROAMER;
    v.mons[AI].curHP = 44;
    expect(run(v)).toEqual(fourMoves(rat(1, 4)));
  });

  it('a replacement that is no one, or the active Pokémon, is a bad view', () => {
    // When the post-KO pick finds none and no slot is alive and unselected, the C's loop ends at the party's size
    // (trainer_ai.c:4013–4027). An Egg isn't ruled out by the fallback's HP-only test (:4017).
    const egg = naturalCureView();
    egg.parties[1].push({ ...egg.parties[1][1]!, species: SPECIES_EGG });
    for (const [v, pick] of [[naturalCureView(), 3], [egg, 3], [naturalCureView(), 0]] as const) {
      vi.mocked(replacement).mockReturnValueOnce(pick);
      expect(() => run(v)).toThrow(code('BAD_VIEW'));
    }
    vi.mocked(shouldSwitch).mockImplementationOnce(() => ({ kind: 'switch', partyIndex: 0 }));
    expect(() => run(fixtureView())).toThrow(code('BAD_VIEW'));
  });

  it('doubles are unsupported', () => {
    expect(() => run(fixtureView({ battleType: BATTLE_TYPE_TRAINER_DOUBLES }))).toThrow(code('UNSUPPORTED'));
  });
});
