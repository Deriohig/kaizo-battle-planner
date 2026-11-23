// The "check" gaps of docs/engine-spot-checks.md, pinned where they match the cartridge and fixed where they did not
// (Perish Song against Soundproof; Knock Off and the resist berries have their own files). bcp = battle_controller_player.c.

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { ABILITY, BAG, fixtureDex, ID, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
/** The player's Monferno (L30) against the trainer's Zigzagoon (L20). */
const duel = (mine: number[], theirs: number[], mineFields: Partial<PlayerMon> = {}, theirFields: Partial<ResolvedMon> = {}) =>
  createBattle({ player: [playerMon(ID.monferno, 30, mine, mineFields)], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, theirs, theirFields)]), field: {} });
const has = (outcome: Outcome, prefix: string): boolean => outcome.log.some((line) => line.startsWith(prefix));
function changed(state: EngineState, change: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  change(battle);
  return snapshot(battle);
}

describe('the gaps that match the cartridge, pinned', () => {
  it('Focus Punch keeps its focus when the hit lands on its user\'s substitute (effect_script_0170.s:5-6; bcp:3360-3378)', () => {
    const start = duel([ID.focusPunch], [ID.tackle]);
    const hitSub = expandTurn(changed(start, (battle) => { expect(battle.p1.active[0]!.addVolatile('substitute')).toBe(true); }), BOTH_FIRST)
      .filter((outcome) => outcome.log.some((line) => line.startsWith('|-activate|p1a: Monferno|') && line.includes('Substitute')));
    const hit = expandTurn(start, BOTH_FIRST).filter((outcome) => has(outcome, '|-damage|p1a: Monferno|'));
    expect([hitSub.length > 0, hit.length > 0]).toEqual([true, true]);
    for (const outcome of hitSub) expect(has(outcome, '|move|p1a: Monferno|Focus Punch|')).toBe(true);
    for (const outcome of hit) expect(has(outcome, '|cant|p1a: Monferno|Focus Punch')).toBe(true);
  });

  it('a pending Micle Berry boost is used up by a move into Protect (bcp:2967-2970 before the Protect override, :3007-3014)', () => {
    const outcomes = expandTurn(changed(duel([ID.megaKick], [ID.protect]), (battle) => { expect(battle.p1.active[0]!.addVolatile('micleberry')).toBe(true); }), BOTH_FIRST);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect([has(outcome, '|-activate|p2a: Zigzagoon|Protect'), has(outcome, '|-enditem|p1a: Monferno|Micle Berry'), restore(outcome.state).p1.active[0]!.volatiles['micleberry']])
        .toEqual([true, true, undefined]);
    }
  });
});

describe('Perish Song against Soundproof (BtlCmd_TryPerishSong, bs:5462-5487)', () => {
  // No count for a battler whose Soundproof applies, the user itself included; it fails when no one gets one
  // (subscript_perish_song_start.s:15-25 shows each block).
  const soundproof = { ability: knownAbility(ABILITY.soundproof) };
  const perish = (outcome: Outcome) => (['p1', 'p2'] as const).map((side) => !!restore(outcome.state)[side].active[0]!.volatiles['perishsong']);
  it.each<[string, Partial<PlayerMon>, Partial<ResolvedMon>, boolean[], string | undefined]>([
    ['the user\'s own Soundproof keeps it from its own count', soundproof, {}, [false, true], undefined],
    ['a Soundproof foe is skipped and shown, the user is not', {}, soundproof, [true, false], '|-immune|p2a: Zigzagoon|[from] ability: Soundproof'],
    ['with every Pokémon skipped it fails', soundproof, soundproof, [false, false], '|-fail|p1a: Monferno'],
  ])('%s', (_, mineFields, theirFields, counts, line) => {
    const outcomes = expandTurn(duel([ID.perishSong], [ID.growl], mineFields, theirFields), BOTH_FIRST);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect(perish(outcome)).toEqual(counts);
      if (line) expect(has(outcome, line)).toBe(true);
    }
  });
});
