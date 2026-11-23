// The view composed from the Showdown source's read throws what the frozen one-pass adapter (test/real/aiLegacyAdapter.ts)
// throws first, by class, code and message, or neither throws and the views are equal, on states made faulty by hand.
import { beforeAll, expect, it } from 'vitest';
import { viewFromState } from '../../../src/ai/adapter.js';
import { type AiMemoryData, initialMemoryData } from '../../../src/ai/memory.js';
import type { AiRomData } from '../../../src/ai/rom/aiData.js';
import type { LoadedData } from '../../../src/battle/types.js';
import type { EngineState } from '../../../src/contracts/engine.js';
import { viewFromState as legacyViewFromState } from '../../real/aiLegacyAdapter.js';
import { ID } from '../engine/fixtures.js';
import {
  ai, both, breakQueue, changed, changedFrom, data, FAULT, installDex, rowless, thrown, uTurnSwitch, weightless,
} from './viewHarness.js';

beforeAll(installDex);

/** Every combination's outcome, and the ones where the composed view differs from the one-pass build's. */
function compare(states: [string, EngineState][], roms: [string, AiRomData][], datas: [string, LoadedData][], memories: [string, AiMemoryData][]) {
  const differ: string[] = [];
  const outcomes = new Set<string>();
  const built = (build: () => unknown): string => {
    let view: unknown;
    const error = thrown(() => { view = build(); });
    return error === 'no throw' ? JSON.stringify(view) : `throws ${error}`;
  };
  for (const [stateName, state] of states) {
    for (const [romName, rom] of roms) {
      for (const [dataName, loaded] of datas) {
        for (const [memoryName, memory] of memories) {
          const want = built(() => legacyViewFromState(state, loaded, rom, memory));
          const got = built(() => viewFromState(state, loaded, rom, memory));
          outcomes.add(got.startsWith('throws ') ? got : 'a view');
          if (got !== want) differ.push(`${stateName}, ${romName}, ${dataName}, ${memoryName}: ${got.slice(0, 160)} where the one-pass build gives ${want.slice(0, 160)}`);
        }
      }
    }
  }
  return { differ, outcomes };
}
const NONE = initialMemoryData(null);
const OVERRIDES: AiMemoryData = { ...NONE, recycleOverride: [ID.tackle, ID.tackle] };
const roms: [string, AiRomData][] = [['all weights', ai], ['no Monferno weight', weightless(ID.monferno)], ['no Zigzagoon weight', weightless(ID.zigzagoon)]];

it('throws what the one-pass adapter threw first, on every combination of faults', () => {
  const { weather, benchStatus, playerLastItem, playerProtecting, enemyChain, enemyTypes, playerDisabled, noBag, noNote, playerItem } = FAULT;
  const faults: [string, (battle: Battle) => void][] = [
    ['none', () => {}], ...Object.entries(FAULT),
    ['weather, benchStatus', both(weather, benchStatus)], ['playerLastItem, weather', both(playerLastItem, weather)],
    ['enemyChain, playerLastItem', both(enemyChain, playerLastItem)], ['playerProtecting, playerLastItem', both(playerProtecting, playerLastItem)],
    ['playerProtecting, enemyChain', both(playerProtecting, enemyChain)], ['enemyTypes, playerDisabled', both(enemyTypes, playerDisabled)],
    ['noBag, noNote', both(noBag, noNote)], ['playerItem, noNote', both(playerItem, noNote)],
    ['everything at once', both(FAULT.enemyStatus, FAULT.playerStatus, benchStatus, weather, playerLastItem)],
  ];
  const { differ, outcomes } = compare(
    faults.map(([name, change]): [string, EngineState] => [name, changed(change)]), roms,
    [['all rows', data], ['no Bidoof row', rowless(ID.bidoof)], ['no Zigzagoon row', rowless(ID.zigzagoon)], ['no Monferno row', rowless(ID.monferno)]],
    [['no override', NONE], ['overrides', OVERRIDES]],
  );
  expect(differ).toEqual([]);
  // The combinations reach every kind of fault: the composer's two, and each the source throws or registers.
  expect(outcomes.size).toBeGreaterThanOrEqual(14);
});

it("throws what the one-pass adapter threw at the AI's mid-turn switch, where only a U-turn action reads the queue", () => {
  // Broken, the queued Ember's move (null) faults the queue's read (pursuitMayRun).
  const switching = uTurnSwitch();
  const broken = changedFrom(switching, breakQueue);
  const { differ, outcomes } = compare([
    ['the switch', switching], ['the switch, the queue broken', broken],
    ['the switch, the queue broken, at a turn choice', { ...broken, phase: { kind: 'turnChoice' } }],
    ['the switch, the queue broken, and the weather', changedFrom(broken, FAULT.weather)],
  ], [roms[0]!, roms[2]!], [['all rows', data]], [
    ['a U-turn action', { ...NONE, switchAction: [ID.uTurn] }], ['no action yet', NONE], ['no action shown (null)', { ...NONE, switchAction: null }],
    ['an Ember action', { ...NONE, switchAction: [ID.ember] }], ['a U-turn action and an override', { ...OVERRIDES, switchAction: [ID.uTurn] }],
  ]);
  expect(differ).toEqual([]);
  expect([...outcomes]).toEqual(expect.arrayContaining(["throws TypeError: Cannot read properties of null (reading 'num')", 'a view']));
});
