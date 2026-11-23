// The rest of the held-item family the cartridge's two triggers check (healing berries, status and confusion cures, Leppa,
// Mental Herb; mod/items.ts `HELD_CHECK_ITEMS`), checked at the pinch berries' points: the switch-in sequence, after every
// hit and move, and twice in the holder's own end-of-turn list (bcp:1362-1368, :1699-1709). The cure berries' end-of-turn
// case is the Thrash lock's fatigue confusion (bcp:1547-1563). HP: Zigzagoon 50 113 (half 56, Sitrus 28); Deoxys 50 165
// (half 82, Sitrus 41), 168 at 51; Monferno 30 87 (half 43).

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { Choice, EngineState, FieldSpec } from '../../../src/contracts/engine.js';
import { createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { ABILITY, BAG, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const SITRUS = ITEM.sitrusBerry; // parameter 25
const SPEED_BOOST = 3;
const PERSIM = 156;

const fixture = fixtureDex();
fixture.data.rom.species[ID.magikarp]!.baseExp = 152; // 684 at level 21
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const to = (index: number): Choice => ({ kind: 'switch', index });
const BOTH = { p1: move(0), p2: move(0) };
const battle = (player: PlayerMon[], trainer: ResolvedMon[], field: FieldSpec = {}): EngineState =>
  createBattle({ player, trainer: resolvedTrainer(BAG.none, trainer), field });
function edited(state: EngineState, edit: (battle: Battle) => void): EngineState {
  const live = restore(state);
  edit(live);
  return snapshot(live);
}
const logOf = (state: EngineState): string[] => (JSON.parse(state.json) as { log: string[] }).log;
const at = (log: readonly string[], prefix: string): number => {
  const index = log.findIndex((line) => line.startsWith(prefix));
  expect(index, `no line ${prefix}`).toBeGreaterThan(-1);
  return index;
};
/** `prefixes` appear in this order. */
const inOrder = (log: readonly string[], ...prefixes: string[]) => {
  const indices = prefixes.map((prefix) => at(log, prefix));
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
};
const foe = (state: EngineState) => restore(state).p2.active[0]!;
const eat = (who: string, berry: string): string => `|-enditem|${who}|${berry}|[eat]`;
const oblivious = knownAbility(ABILITY.oblivious);
/** The player's Sitrus Deoxys 50 (Speed Boost: no Magic Guard), 1 EXP short of 51, with `moves`. */
const sitrusDeoxys = (moves: number[]) => playerMon(ID.deoxys, 50, moves, { exp: 165813 - 1, item: SITRUS, ability: knownAbility(SPEED_BOOST) });
const magikarpFirst = () => [resolvedMon(ID.magikarp, 21, [ID.meanLook]), resolvedMon(ID.zigzagoon, 21, [ID.growl])];
const levelled = (state: EngineState) => {
  const deoxys = restore(state).p1.active[0]!;
  return [deoxys.level, deoxys.hp, deoxys.maxhp, deoxys.item];
};

describe('the end of turn: in the holder\'s own list (bcp:1362-1368, :1699-1709)', () => {
  it('a Sitrus Berry the sandstorm takes to half HP is eaten at the use-item step, before Toxic: the holder lives', () => {
    // 60 - 7 (sand) = 53 <= 56, +28 = 81, then Toxic's 9th stage 63: 18. Showdown's `Update` came after the knock-out.
    const after = runFirstOutcome(edited(battle([playerMon(ID.deoxys, 50, [ID.growl])], [resolvedMon(ID.zigzagoon, 50, [ID.growl], { item: SITRUS, ability: oblivious }), resolvedMon(ID.zigzagoon, 50, [ID.growl])], { weather: 'sand' }), (live) => {
      live.p2.active[0]!.hp = 60;
      live.p2.active[0]!.setStatus('tox');
      live.p2.active[0]!.statusState['stage'] = 8;
    }), BOTH);
    inOrder(logOf(after), '|-damage|p2a: Zigzagoon|53/113 tox|[from] Sandstorm', eat('p2a: Zigzagoon', 'Sitrus Berry'), '|-damage|p2a: Zigzagoon|18/113 tox|[from] psn');
    expect([foe(after).hp, foe(after).item, foe(after).fainted]).toEqual([18, '', false]);
  });

  it('an end-of-turn level-up: the player\'s faster Sitrus holder eats in its own list, before the enemy\'s poison faint pays it', () => {
    // At 92: sand leaves 82 <= 82, +41 = 123; the poisoned Magikarp faints in its list, level 51 adds 3: 126 (Showdown: 85, held).
    const after = runFirstOutcome(edited(battle([sitrusDeoxys([ID.growl])], magikarpFirst(), { weather: 'sand' }), (live) => {
      live.p1.active[0]!.hp = 92;
      live.p2.active[0]!.hp = 6;
      live.p2.active[0]!.setStatus('psn');
    }), BOTH);
    inOrder(logOf(after), eat('p1a: Deoxys', 'Sitrus Berry'), '|faint|p2a: Magikarp');
    expect(levelled(after)).toEqual([51, 126, 168, '']);
  });

  it('the item-condition step, after the poison: the holder its own poison takes to half HP eats before the enemy\'s list', () => {
    // At 100, its poison leaves 80 <= 82: +41 = 121, then the Magikarp's poison faint pays level 51 (+3): 124 (checked only at
    // the next turn's start, the level-up would come first and the berry give 42: 125).
    const after = runFirstOutcome(edited(battle([sitrusDeoxys([ID.growl])], magikarpFirst()), (live) => {
      live.p1.active[0]!.hp = 100;
      live.p1.active[0]!.setStatus('psn');
      live.p2.active[0]!.hp = 5;
      live.p2.active[0]!.setStatus('psn');
    }), BOTH);
    inOrder(logOf(after), '|-damage|p1a: Deoxys|80/165 psn|[from] psn', eat('p1a: Deoxys', 'Sitrus Berry'), '|faint|p2a: Magikarp');
    expect(levelled(after)).toEqual([51, 124, 168, '']);
  });

  it('a cure berry at the item-condition step: the Thrash lock\'s fatigue confusion is cured before the next battler\'s list', () => {
    // The faster Zigzagoon's lock ends now (elapsed 2) and confuses it; its Persim Berry goes before the Machop's poison.
    const after = runFirstOutcome(edited(battle([playerMon(ID.zigzagoon, 50, [ID.unblockable], { item: PERSIM, ability: oblivious })],
      [resolvedMon(ID.machop, 50, [ID.meanLook], { ability: oblivious })]), (live) => {
      const zigzagoon = live.p1.active[0]!;
      expect(zigzagoon.addVolatile('lockedmove', zigzagoon, live.dex.getActiveMove(zigzagoon.moveSlots[0]!.id))).toBe(true);
      zigzagoon.volatiles['lockedmove']!['elapsed'] = 2;
      live.p2.active[0]!.setStatus('psn');
    }), BOTH);
    const log = logOf(after);
    const poison = log.findIndex((line) => line.startsWith('|-damage|p2a: Machop|') && line.endsWith('[from] psn'));
    expect(poison).toBeGreaterThan(-1);
    expect(at(log, eat('p1a: Zigzagoon', 'Persim Berry'))).toBeGreaterThan(at(log, '|-start|p1a: Zigzagoon|confusion|[fatigue]'));
    expect(at(log, eat('p1a: Zigzagoon', 'Persim Berry'))).toBeLessThan(poison);
    expect([restore(after).p1.active[0]!.volatiles['confusion'], restore(after).p1.active[0]!.item]).toEqual([undefined, '']);
  });

  it('never under Klutz', () => {
    let state = edited(battle([playerMon(ID.deoxys, 50, [ID.growl])], [resolvedMon(ID.zigzagoon, 50, [ID.growl], { item: SITRUS, ability: knownAbility(ABILITY.klutz) })]),
      (live) => { live.p2.active[0]!.hp = 30; });
    for (let turn = 0; turn < 2; turn++) state = runFirstOutcome(state, BOTH);
    expect(foe(state).item).toBe('sitrusberry');
  });
});

describe('after a move (bcp:3672-3698, :3730-3755)', () => {
  it('a recoil knock-out with a replacement to come: the Sitrus Berry is eaten before the EXP payout\'s level-up', () => {
    // Sky Attack (1/3 recoil) deals 30 to the Magikarp at 30: 10 back from 92 is 82 <= 82, +41, then level 51: 126.
    const after = runFirstOutcome(edited(battle([sitrusDeoxys([ID.skyAttack])], magikarpFirst()), (live) => {
      live.p1.active[0]!.hp = 92;
      live.p2.active[0]!.hp = 30;
    }), BOTH);
    expect(after.phase.kind).toBe('enemyReplacement');
    inOrder(logOf(after), '|-damage|p1a: Deoxys|82/165|[from] Recoil', eat('p1a: Deoxys', 'Sitrus Berry'), '|-kaizoexp|');
    expect(levelled(after)).toEqual([51, 126, 168, '']);
  });

  it('a U-turn user knocked to half HP by Rough Skin leaves with its Sitrus Berry, and eats it when it comes back', () => {
    // 50 - 87 / 8 = 40 <= 43; no held-item check runs on the user before it goes (subscript_attack_then_switch_out.s:7-12).
    const start = edited(battle([playerMon(ID.monferno, 30, [ID.uTurn, ID.growl], { item: SITRUS }), playerMon(ID.zigzagoon, 20, [ID.growl])],
      [resolvedMon(ID.zigzagoon, 50, [ID.growl], { ability: knownAbility(ABILITY.roughSkin) })]), (live) => { live.p1.active[0]!.hp = 50; });
    const mid = runFirstOutcome(start, BOTH);
    expect(mid.phase.kind).toBe('playerMidTurnSwitch');
    const out = runFirstOutcome(mid, { p1: to(1) });
    const monferno = restore(out).p1.pokemon.find((pokemon) => pokemon.name === 'Monferno')!;
    expect([monferno.hp, monferno.item]).toEqual([40, 'sitrusberry']);
    inOrder(logOf(runFirstOutcome(out, { p1: to(0), p2: move(0) })), '|switch|p1a: Monferno', eat('p1a: Monferno', 'Sitrus Berry'), '|move|p2a: Zigzagoon|');
  });
});
