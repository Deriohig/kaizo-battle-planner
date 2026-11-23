import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Choice, EngineState } from '../../../src/contracts/engine.js';
import { applyChoices, createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { stateKey } from '../../../src/engine/key.js';
import { emberTurn, fixtureDex } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const CHOICE_BAND = 220;

/** The key of `state` after `change` to its battle. */
function keyAfter(state: EngineState, change: (battle: Battle) => void): string {
  const battle = restore(state);
  change(battle);
  return stateKey(battle);
}

describe('state key', () => {
  it('log does not change the key', () => {
    const state = createBattle(emberTurn());
    const battle = restore(state);
    const key = stateKey(battle);
    expect(key).toBe(state.key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    battle.log.push('|t:|0', '|-message|Hello');
    battle.inputLog.push('>p1 move 1');
    battle.hints.add('A hint');
    Object.assign(battle, { lastMoveLine: 7, sentLogPos: 3, sentEnd: true, sentRequests: false });
    expect(stateKey(battle)).toBe(key);
    battle.p2.active[0]!.hp -= 1;
    expect(stateKey(battle)).not.toBe(key);
  });

  it('same state, same key: at different times (the |t:| lines are blanked), and by different paths', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const early = createBattle(emberTurn());
    now.mockReturnValue(2_000_000_000_000);
    const late = createBattle(emberTurn());
    now.mockRestore();
    expect([early.json, early.key]).toEqual([late.json, late.key]);
    // The roll pick has one option per damage value: every crit value knocks Zigzagoon out (one key); without the crit
    // each leaves its own HP and has its own key.
    const runWith = (script: number[]) => {
      const driver = new ChanceDriver(script);
      const battle = restore(early, driver);
      applyChoices(battle, { p1: move(0), p2: move(0) });
      return { battle, key: snapshot(battle).key, points: driver.points };
    };
    const keysByHp = (crit: boolean) => {
      const first = runWith(crit ? [] : [1]); // the crit point's options: crit, then no crit
      expect(first.points[0]!.kind).toBe('crit');
      const roll = first.points.findIndex((point) => point.kind === 'roll');
      const before = first.points.slice(0, roll).map((point) => point.chosen);
      const keys = new Map<number, Set<string>>();
      for (let value = 0; value < first.points[roll]!.options.length; value++) {
        // Past the roll the burn (when Zigzagoon is still up) takes its last option: no burn.
        const { battle, key } = runWith([...before, value, ...(crit ? [] : [1])]);
        const hp = battle.p2.active[0]!.hp;
        keys.set(hp, (keys.get(hp) ?? new Set()).add(key));
      }
      return { keys, values: first.points[roll]!.options.length };
    };
    const crits = keysByHp(true);
    expect([crits.values > 1, [...crits.keys.keys()], crits.keys.get(0)!.size]).toEqual([true, [0], 1]);
    const plain = keysByHp(false);
    expect([plain.keys.size, [...plain.keys.values()].every((keys) => keys.size === 1), new Set([...plain.keys.values()].map((keys) => [...keys][0])).size])
      .toEqual([plain.values, true, plain.values]);
  });

  it('every counter changes the key', () => {
    // A save sleep counter of 3 and a Choice Band; after a turn the foe gets Disable, a Protect counter, rain and a move's sleep.
    const start = createBattle(emberTurn([33], { status: { kind: 'sleep', turns: 3 }, item: CHOICE_BAND }));
    const battle = restore(runFirstOutcome(start, { p1: move(1), p2: move(0) }));
    const [mine, foe] = [battle.p1.active[0]!, battle.p2.active[0]!];
    expect(foe.addVolatile('disable', mine)).toBe(true);
    expect(foe.addVolatile('stall')).toBe(true);
    expect(battle.field.setWeather('raindance', mine)).toBe(true);
    expect(foe.setStatus('slp', mine)).toBe(true);
    const state = snapshot(battle);
    const base = state.key;
    // Hidden counters are kept as elapsed counts (`slept`, `elapsed`); a counter known from the save stays exact (`time`).
    const changes: Record<string, (changed: Battle) => void> = {
      'turns slept (a known counter)': (changed) => { changed.p1.active[0]!.statusState.time -= 1; },
      'turns slept (a move\'s sleep)': (changed) => { changed.p2.active[0]!.statusState['slept'] += 1; },
      'PP': (changed) => { changed.p1.active[0]!.moveSlots[0]!.pp -= 1; },
      'Disable turns elapsed': (changed) => { changed.p2.active[0]!.volatiles['disable']!['elapsed'] += 1; },
      'the Protect counter': (changed) => { changed.p2.active[0]!.volatiles['stall']!.counter += 1; },
      'weather turns': (changed) => { changed.field.weatherState.duration! -= 1; },
      'a consumed item': (changed) => { expect(changed.p1.active[0]!.useItem()).toBe(true); },
      'the turn number': (changed) => { changed.turn += 1; },
    };
    const keys = Object.entries(changes).map(([name, change]) => [name, keyAfter(state, change)] as const);
    for (const [name, key] of keys) expect(key, name).not.toBe(base);
    expect(new Set(keys.map(([, key]) => key)).size).toBe(keys.length);
  });
});
