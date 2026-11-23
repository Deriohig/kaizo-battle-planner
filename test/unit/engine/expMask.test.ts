// The cartridge's EXP participation mask: which of the player's party count as having fought the enemy's active Pokémon
// (src/engine/mod/exp.ts cites the rule). One scripted battle per kind of send-out, the mask checked after each step.
// bs = battle_script.c, bl = battle_lib.c, sub/ = res/battle/scripts/subscripts/. The engine's mask is canonical: a
// Pokémon at 0 HP never holds a bit (the cartridge keeps such bits but never pays them, bs:9740).

import { beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, Choice, EngineState, Outcome, Phase, Side } from '../../../src/contracts/engine.js';
import { applyChoices, choicesIn, createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver, nextScript } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { EXP_MASK_KEY } from '../../../src/engine/mod/exp.js';
import { add, ONE, ZERO } from '../../../src/engine/rational.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const to = (index: number): Choice => ({ kind: 'switch', index });
type Choices = { p1?: Choice; p2?: Choice };

/** The party indices whose bits the state's mask holds; undefined when it holds no mask. */
function participants(state: EngineState): number[] | undefined {
  const mask = (JSON.parse(state.json) as { formatData: Record<string, unknown> }).formatData[EXP_MASK_KEY];
  return typeof mask === 'number' ? [0, 1, 2, 3, 4, 5].filter((index) => (mask & (1 << index)) !== 0) : undefined;
}
const sumOf = (outcomes: readonly Outcome[]) => outcomes.reduce((sum, outcome) => add(sum, outcome.probability), ZERO);

const mon = (species: number, level: number, moves: number[] = [ID.growl]) => playerMon(species, level, moves);
const foe = (species: number, level: number, moves: number[] = [ID.growl]) => resolvedMon(species, level, moves);
const battle = (player: BattleInput['player'], trainer: ReturnType<typeof resolvedMon>[]): EngineState =>
  createBattle({ player, trainer: resolvedTrainer(BAG.none, trainer), field: {} });
// Monferno (L30: Growl, U-turn, Baton Pass, Roar), Zigzagoon (L20) and Machop (L20).
const playerTeam = () => [mon(ID.monferno, 30, [ID.growl, ID.uTurn, ID.batonPass, ID.roar]), mon(ID.zigzagoon, 20, [ID.growl, ID.plainHit]), mon(ID.machop, 20)];
/** The player's three against a fast Deoxys (L50: Growl, Roar, Baton Pass, U-turn) and a Zigzagoon (L20). */
const againstDeoxys = () => battle(playerTeam(), [foe(ID.deoxys, 50, [ID.growl, ID.roar, ID.batonPass, ID.uTurn]), foe(ID.zigzagoon, 20)]);
/** The player's three against a Magikarp a U-turn knocks out, then a Deoxys. */
const againstMagikarp = () => battle(playerTeam(), [foe(ID.magikarp, 5), foe(ID.deoxys, 50)]);
const SWAP1 = { p1: to(1), p2: move(0) };
const BACK0 = { p1: to(0), p2: move(0) };
const SECOND = { p1: move(1), p2: move(0) };

type Step = [Choices, Phase['kind'], number[]?, ((state: EngineState) => void)?];
const active = (side: Side, species: string) => (state: EngineState) => expect(restore(state)[side].active[0]!.species.name).toBe(species);
const logs = (line: string) => (state: EngineState) => expect(JSON.parse(state.json).log).toContain(line);

describe('the mask after each send-out', () => {
  it.each<{ name: string; start: () => EngineState; first?: number[]; steps: Step[] }>([
    { name: 'the battle start holds the lead alone (sub/subscript_start_encounter.s:84, :91)', start: againstDeoxys, first: [0], steps: [] },
    { name: 'the battle start with a party of one', start: () => battle([mon(ID.monferno, 30)], [foe(ID.zigzagoon, 20)]), first: [0], steps: [] },
    // The player's send-outs add the newcomer while the enemy has HP (bs:621-622, bl:1461-1478).
    { name: 'a switch adds the newcomer; whoever left keeps its bit; bits are party indices, not positions', start: againstDeoxys,
      steps: [[SWAP1, 'turnChoice', [0, 1]], [{ p1: to(2), p2: move(0) }, 'turnChoice', [0, 1, 2]], [BACK0, 'turnChoice', [0, 1, 2]]] },
    { name: 'U-turn, the enemy survives: the newcomer is added (sub/subscript_attack_then_switch_out.s:71)', start: againstDeoxys,
      steps: [[SECOND, 'playerMidTurnSwitch', [0]], [{ p1: to(1) }, 'turnChoice', [0, 1]]] },
    // The newcomer comes in while the enemy has 0 HP (bl:1469); the benched U-turn user is paid, which clears the mask.
    { name: 'U-turn knocks the enemy out: the newcomer is not added; the enemy\'s replacement starts its own mask', start: againstMagikarp,
      steps: [[SECOND, 'playerMidTurnSwitch', [0]], [{ p1: to(1) }, 'enemyReplacement', [], logs('|-kaizoexp|p1: Monferno|1')], [{ p2: to(1) }, 'turnChoice', [1]]] },
    { name: 'Baton Pass adds the newcomer (sub/subscript_baton_pass.s:17)', start: againstDeoxys,
      steps: [[{ p1: move(2), p2: move(0) }, 'playerMidTurnSwitch', [0]], [{ p1: to(1) }, 'turnChoice', [0, 1]]] },
    { name: 'a replacement after a faint is added, and the fainted Pokémon\'s bit goes (sub/subscript_replace_fainted.s:58)',
      start: () => battle([mon(ID.monferno, 30), mon(ID.zigzagoon, 5), mon(ID.machop, 20)], [foe(ID.deoxys, 50, [ID.plainHit])]),
      steps: [[SWAP1, 'playerReplacement'], [{ p1: to(2) }, 'turnChoice', [0, 2]]] },
    { name: 'a replacement for a fainted lead holds the newcomer alone', start: () => battle([mon(ID.zigzagoon, 5), mon(ID.monferno, 30)], [foe(ID.deoxys, 50, [ID.plainHit])]),
      steps: [[{ p1: move(0), p2: move(0) }, 'playerReplacement'], [{ p1: to(1) }, 'turnChoice', [1]]] },
    { name: 'Roar drags the player\'s Pokémon in: it is added (bs:607-608)', start: againstDeoxys,
      steps: [[{ p1: move(0), p2: move(1) }, 'turnChoice', [0, 1], active('p1', 'Zigzagoon')]] },
    { name: 'a switch through Pursuit: the newcomer is added, the Pokémon knocked out is not',
      start: () => battle([mon(ID.zigzagoon, 5), mon(ID.monferno, 30)], [foe(ID.deoxys, 50, [ID.pursuit])]), steps: [[SWAP1, 'turnChoice', [1], active('p1', 'Monferno')]] },
    // An enemy send-out starts the mask again as the player's active Pokémon alone (bs:625-626, bl:1456-1478).
    { name: 'the enemy switches; back again, those who fought it before no longer count', start: againstDeoxys,
      steps: [[SWAP1, 'turnChoice', [0, 1]], [{ p1: move(0), p2: to(1) }, 'turnChoice', [1]], [{ p1: move(0), p2: to(0) }, 'turnChoice', [1], active('p2', 'Deoxys')]] },
    { name: 'the enemy\'s Baton Pass', start: againstDeoxys,
      steps: [[SWAP1, 'turnChoice'], [{ p1: move(0), p2: move(2) }, 'enemyMidTurnSwitch', [0, 1]], [{ p2: to(1) }, 'turnChoice', [1]]] },
    { name: 'the enemy\'s U-turn', start: againstDeoxys,
      steps: [[SWAP1, 'turnChoice'], [BACK0, 'turnChoice', [0, 1]], [{ p1: move(0), p2: move(3) }, 'enemyMidTurnSwitch', [0, 1]], [{ p2: to(1) }, 'turnChoice', [0]]] },
    // Its newcomer comes in while the player's fainted Pokémon is still active: never paid, so the canonical mask is empty.
    { name: 'the enemy\'s U-turn knocks the player\'s out: the newcomer\'s mask is empty until the player\'s replacement',
      start: () => battle([mon(ID.zigzagoon, 5), mon(ID.monferno, 30)], [foe(ID.deoxys, 50, [ID.uTurn]), foe(ID.zigzagoon, 20)]),
      steps: [[{ p1: move(0), p2: move(0) }, 'enemyMidTurnSwitch'], [{ p2: to(1) }, 'playerReplacement', []], [{ p1: to(1) }, 'turnChoice', [1]]] },
    { name: 'the enemy\'s replacement after a faint', start: () => battle([mon(ID.monferno, 30), mon(ID.zigzagoon, 20, [ID.plainHit])], [foe(ID.magikarp, 5), foe(ID.deoxys, 50)]),
      steps: [[SWAP1, 'turnChoice', [0, 1]], [{ p1: move(0), p2: move(0) }, 'enemyReplacement'], [{ p2: to(1) }, 'turnChoice', [1]]] },
    { name: 'Roar on the enemy starts a fresh mask, and again when the old enemy is dragged back (bs:610-611)',
      start: () => battle([mon(ID.monferno, 30, [ID.growl, ID.roar]), mon(ID.zigzagoon, 20)], [foe(ID.deoxys, 30), foe(ID.zigzagoon, 20)]),
      steps: [[SWAP1, 'turnChoice'], [BACK0, 'turnChoice', [0, 1]], [SECOND, 'turnChoice', [0], active('p2', 'Zigzagoon')], [SECOND, 'turnChoice', [0], active('p2', 'Deoxys')]] },
    // Set after the hazards, Shedinja would have had 0 HP and nobody would be paid (bl:1469). Base EXP 0: a share of 1.
    { name: 'the mask is set before the newcomer\'s hazards: an enemy Spikes knock out on its way in was counted (sub/subscript_switch_pokemon.s:39, :43)',
      start: () => battle([mon(ID.monferno, 30, [ID.growl, ID.spikes]), mon(ID.zigzagoon, 20)], [foe(ID.deoxys, 50), foe(ID.shedinja, 20), foe(ID.zigzagoon, 20)]),
      steps: [[SECOND, 'turnChoice'], [SWAP1, 'turnChoice', [0, 1]], [{ p1: move(0), p2: to(1) }, 'enemyReplacement', [], logs('|-kaizoexp|p1a: Zigzagoon|1')],
        [{ p2: to(2) }, 'turnChoice', [1]]] },
    // Both replace at once: the player's first, with no speed compare (bs:2408-2413); the enemy's newcomer then clears the mask.
    { name: 'both sides replace at once: the new enemy holds the player\'s new Pokémon alone, even against a faster enemy',
      start: () => battle([mon(ID.monferno, 30, [ID.explosion]), mon(ID.zigzagoon, 20), mon(ID.machop, 20)], [foe(ID.magikarp, 5), foe(ID.deoxys, 50)]),
      steps: [[{ p1: move(0), p2: move(0) }, 'playerReplacement'], [{ p1: to(2), p2: to(1) }, 'turnChoice', [2]]] },
  ])('$name', ({ start, first, steps }) => {
    let state = start();
    if (first) expect(participants(state)).toEqual(first);
    for (const [index, [choices, phase, mask, check]] of steps.entries()) {
      state = runFirstOutcome(state, choices);
      expect([index, state.phase.kind]).toEqual([index, phase]);
      if (mask) expect([index, participants(state)]).toEqual([index, mask]);
      check?.(state);
    }
  });
});

describe('the mask is state', () => {
  it('is in the key: two states that differ only by the mask have different keys', () => {
    const state = runFirstOutcome(againstDeoxys(), SWAP1);
    expect([participants(state), snapshot(restore(state)).key]).toEqual([[0, 1], state.key]);
    const other = restore(state);
    other.formatData[EXP_MASK_KEY] = 0b001;
    const changed = snapshot(other);
    expect(participants(changed)).toEqual([0]);
    expect(changed.key).not.toBe(state.key);
  });

  /**
   * Every pair of steps from `state`: `first`, then from each leaf that stops mid-turn, that side's first legal choice,
   * run on a restore of the mid-turn snapshot and on the live battle that made it: each pair's keys and masks.
   */
  function liveAndRestored(state: EngineState, first: Choices): { keys: [string, string]; masks: [number[] | undefined, number[] | undefined] }[] {
    const pairs: { keys: [string, string]; masks: [number[] | undefined, number[] | undefined] }[] = [];
    for (let script: number[] | null = []; script !== null;) {
      const driver = new ChanceDriver(script);
      const live = restore(state, driver);
      applyChoices(live, first);
      const mid = snapshot(live);
      script = nextScript(driver.points);
      if (!mid.phase.kind.endsWith('MidTurnSwitch')) continue;
      const side: Side = mid.phase.kind.startsWith('player') ? 'p1' : 'p2';
      const choice = choicesIn(live, side)[0]!;
      for (let second: number[] | null = []; second !== null;) {
        const restoredDriver = new ChanceDriver(second);
        const restored = restore(mid, restoredDriver);
        applyChoices(restored, { [side]: choice });
        const again = restore(state, new ChanceDriver([...driver.points, ...restoredDriver.points].map((point) => point.chosen)));
        applyChoices(again, first);
        applyChoices(again, { [side]: choice });
        const [a, b] = [snapshot(again), snapshot(restored)];
        pairs.push({ keys: [a.key, b.key], masks: [participants(a), participants(b)] });
        second = nextScript(restoredDriver.points);
      }
    }
    return pairs;
  }

  it.each<[string, () => EngineState, Choices, number[]]>([
    ['the player\'s U-turn', againstDeoxys, SECOND, [0, 1]],
    ['the player\'s Baton Pass', againstDeoxys, { p1: move(2), p2: move(0) }, [0, 1]],
    ['the player\'s U-turn that knocks the enemy out (paid after the switch, the mask cleared)', againstMagikarp, SECOND, []],
    ['the enemy\'s U-turn', againstDeoxys, { p1: move(0), p2: move(3) }, [0]],
  ])('a restore of the mid-turn state continues as the live battle does: %s', (_, start, first, mask) => {
    const pairs = liveAndRestored(start(), first);
    expect(pairs.length).toBeGreaterThan(0);
    for (const { keys, masks } of pairs) {
      expect(keys[1]).toBe(keys[0]);
      expect(masks).toEqual([mask, mask]);
    }
  });
});

describe('outcomes still sum to exactly one, each with its mask', () => {
  it('U-turn, surviving or knocking out: every outcome stops mid-turn with the user\'s bit; every continuation adds the newcomer, or pays and clears', () => {
    for (const [start, after] of [[againstDeoxys, [0, 1]], [againstMagikarp, []]] as const) {
      const outcomes = expandTurn(start(), SECOND);
      expect(sumOf(outcomes)).toEqual(ONE);
      for (const outcome of outcomes) {
        expect([outcome.state.phase.kind, participants(outcome.state)]).toEqual(['playerMidTurnSwitch', [0]]);
        const next = expandTurn(outcome.state, { p1: to(1) });
        expect(sumOf(next)).toEqual(ONE);
        for (const each of next) {
          expect(participants(each.state)).toEqual(after);
          if (after.length === 0) expect(each.log).toContain('|-kaizoexp|p1: Monferno|1');
        }
      }
    }
  });

  it('a Roar that drags either bench Pokémon: each outcome adds the one dragged in', () => {
    const outcomes = expandTurn(againstDeoxys(), { p1: move(0), p2: move(1) });
    expect(sumOf(outcomes)).toEqual(ONE);
    const dragged = new Set<number>();
    for (const outcome of outcomes) {
      const index = outcome.log.some((line) => line.startsWith('|drag|p1a: Zigzagoon')) ? 1 : 2;
      dragged.add(index);
      expect(participants(outcome.state)).toEqual([0, index]);
    }
    expect([...dragged].sort()).toEqual([1, 2]);
  });
});
