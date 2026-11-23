// Setup for model.test.ts and adapter.test.ts: the engine's fixture battles with added moves, and hand-assembled AI scripts.

import { expect } from 'vitest';
import { BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED, TYPE_STEEL } from '../../../src/ai/constants.js';
import { AiError } from '../../../src/ai/errors.js';
import type { AiRomData } from '../../../src/ai/rom/aiData.js';
import type { AiScript } from '../../../src/ai/rom/script.js';
import { scriptId } from '../../../src/ai/script/disasm.js';
import type { LoadedData, ResolvedMon } from '../../../src/battle/types.js';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { applyChoices, expandTurn, restore, snapshot } from '../../../src/engine/index.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import { AI_FLAG_NAMES, type AiFlagName } from '../../../src/rom/trainers.js';
import type { MoveRecord } from '../../../src/rom/types.js';
import { AI_MASK, AI_TRAINER, BAG, fixtureData, ID, playerMon, resolvedMon, resolvedTrainer } from '../engine/fixtures.js';
import { assemble } from './asm.js';
import { fixtureDeps, FX } from './fixtures.js';

/** The added moves (line − 1 of generated/moves.txt). */
export const MOVE = {
  swordsDance: 14, disable: 50, seismicToss: 69, thunderWave: 86, toxic: 92, confuseRay: 109, reflect: 115, transform: 144, protect: 182,
  spikes: 191, perishSong: 195, sandstorm: 201, encore: 227, pursuit: 228, rainDance: 240, sunnyDay: 241, uproar: 253, hail: 258, torment: 259,
  ingrain: 275, revenge: 279, imprison: 286, gravity: 356, gyroBall: 360, tailwind: 366, embargo: 373, gastroAcid: 380, magnetRise: 393,
  trickRoom: 433, bugBite: 450,
} as const;

/**
 * Vanilla records: [id, name, effect, type, pp, fields over a status move that never misses]. Invented: Disable, Toxic, Encore,
 * Seismic Toss, Revenge and Pursuit never miss (no hit chance in setup turns); Bug Bite has power 10 (Zigzagoon stays above half HP).
 */
const ADDED: readonly [number, string, number, number, number, Partial<MoveRecord>?][] = [
  [MOVE.swordsDance, 'Swords Dance', 50, 0, 30, { target: 16, flags: 8 }], [MOVE.reflect, 'Reflect', 65, 14, 20, { target: 32, flags: 8 }],
  [MOVE.spikes, 'Spikes', 112, 4, 20, { target: 64 }], [MOVE.imprison, 'Imprison', 192, 14, 10, { target: 16 }],
  [MOVE.disable, 'Disable', 86, 0, 20, { flags: 18 }], [MOVE.toxic, 'Toxic', 33, 3, 10, { flags: 18 }], [MOVE.encore, 'Encore', 90, 0, 5, { flags: 18 }],
  [MOVE.thunderWave, 'Thunder Wave', 67, 13, 20, { accuracy: 100, flags: 18 }], [MOVE.confuseRay, 'Confuse Ray', 49, 7, 10, { accuracy: 100, flags: 18 }],
  [MOVE.torment, 'Torment', 165, 17, 15, { accuracy: 100 }], [MOVE.embargo, 'Embargo', 232, 17, 15, { accuracy: 100 }],
  [MOVE.gastroAcid, 'Gastro Acid', 239, 3, 10, { accuracy: 100 }], [MOVE.protect, 'Protect', 111, 0, 10, { priority: 3 }],
  [MOVE.trickRoom, 'Trick Room', 259, 14, 5, { priority: -7 }], [MOVE.transform, 'Transform', 57, 0, 10], [MOVE.perishSong, 'Perish Song', 114, 0, 5],
  [MOVE.sandstorm, 'Sandstorm', 115, 5, 10], [MOVE.rainDance, 'Rain Dance', 136, 11, 5], [MOVE.sunnyDay, 'Sunny Day', 137, 10, 5],
  [MOVE.hail, 'Hail', 164, 15, 10], [MOVE.ingrain, 'Ingrain', 181, 12, 20], [MOVE.gravity, 'Gravity', 215, 14, 5],
  [MOVE.tailwind, 'Tailwind', 225, 2, 30], [MOVE.magnetRise, 'Magnet Rise', 252, 13, 10],
  [MOVE.seismicToss, 'Seismic Toss', 87, 1, 20, { category: 'physical', power: 1 }], [MOVE.pursuit, 'Pursuit', 128, 17, 20, { category: 'physical', power: 40 }],
  [MOVE.revenge, 'Revenge', 185, 1, 10, { category: 'physical', power: 60, priority: -4 }],
  [MOVE.bugBite, 'Bug Bite', 224, 6, 20, { category: 'physical', power: 10, accuracy: 100 }],
  [MOVE.gyroBall, 'Gyro Ball', BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED, TYPE_STEEL, 5, { category: 'physical', power: 1, accuracy: 100 }],
  [MOVE.uproar, 'Uproar', 159, 0, 10, { category: 'special', power: 50, accuracy: 100 }],
];

/** The named flags of a raw AI mask, as the ROM decoder gives RomTrainer.aiFlags. */
export const flagsOf = (mask: number): AiFlagName[] => AI_FLAG_NAMES.filter((_, bit) => (mask >>> bit) & 1);

const NONE: MoveRecord = { id: 0, effect: 0, category: 'physical', power: 0, type: 0, accuracy: 0, pp: 0, effectChance: 0, target: 0, priority: 0, flags: 0 };
let built: LoadedData | undefined;

/**
 * The engine's fixture data, built once, with the added moves (each with a docs row of its name), MOVE_NONE's record and
 * species record 0 (a real ROM has both), and AI masks: AI_TRAINER keeps the fixture's, every other trainer runs bit 0.
 */
export function modelData(): LoadedData {
  if (built) return built;
  const data = fixtureData();
  data.rom.moves[0] = { ...NONE };
  const zero = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  data.rom.species[0] = { id: 0, baseStats: zero, types: [0, 0], genderRatio: 0, baseFriendship: 0, baseExp: 0, evYield: 0, growthRate: 0, abilities: [0, 0] };
  data.rom.trainers = data.rom.trainers.map((trainer) => {
    const aiMask = trainer.index === AI_TRAINER.first ? AI_MASK.first : trainer.index === AI_TRAINER.second ? AI_MASK.second : 1;
    return { ...trainer, aiMask, aiFlags: flagsOf(aiMask) };
  });
  for (const [id, name, effect, type, pp, more] of ADDED) {
    const rom: MoveRecord = { ...NONE, id, effect, category: 'status', type, pp, ...more };
    data.rom.moves[id] = rom;
    const { category, power, accuracy, priority } = rom;
    data.docs.moves.push({ id, name, effectText: `${name} effect`, category, power, type: '', accuracy, pp, effectChance: 0, targets: '', priority, contact: false });
  }
  data.names = buildNameIndex(data.docs);
  return (built = data);
}

/** Pokédex weights (vanilla, hectograms) for the fixture species, 0 elsewhere, with `changes` over them. */
export function weightTable(changes: Record<number, number> = {}): number[] {
  const table = Array<number>(494).fill(0);
  return Object.assign(table, { [ID.zigzagoon]: 175, [ID.castform]: 8, [ID.deoxys]: 608, [ID.monferno]: 220, [ID.bidoof]: 200 }, changes);
}

/** `src` with `Terminate: PopOrEnd` appended, run as AI flag bit 0 (every other flag runs Terminate). */
export function flagScript(src: string): AiScript {
  const { words, labels } = assemble(`${src}\nTerminate: PopOrEnd`);
  const flagEntries = Array<number>(32).fill(labels.Terminate!);
  flagEntries[0] = 0;
  return { words, flagEntries, sha256: '' };
}

export const NOTHING = 'PopOrEnd'; // a script that leaves every score as it is

/** The AI's ROM data running `src` as flag bit 0, with the AI fixture's items (plus Super Potion) and type chart. */
export function romWith(src: string = NOTHING): AiRomData {
  const script = flagScript(src);
  const { items, typeChart } = fixtureDeps();
  items[26] = { ...items[FX.item.POTION]!, id: 26, holdParam: 50, hpRestored: 50 }; // Super Potion, in BAG.potions
  return {
    scriptWords: Array.from(script.words), flagEntries: script.flagEntries, scriptSha256: scriptId(script), items, typeChart,
    weights: weightTable(), formWeights: weightTable(),
  };
}

export const move = (slot: number): Choice => ({ kind: 'move', slot });

export const ability = (value: number): Pick<ResolvedMon, 'ability'> => ({ ability: { value, source: 'rom', disputed: false, alternatives: [] } });

/** Monferno (L30, Leftovers, `moves`), faster, against Zigzagoon (L20; Thunder Wave, Reflect, Tackle, Mean Look; Sitrus
 * Berry; `lead` over it) and Bidoof (L25, `bidoof`), with ROM trainer `bag`'s bag. */
export function battle(moves: number[], lead: Partial<ResolvedMon> = {}, bag: number = BAG.potions, bidoof: number[] = [ID.waterBall]): BattleInput {
  const data = modelData();
  return {
    player: [playerMon(ID.monferno, 30, [ID.ember], {
      moves, pp: moves.map((id) => data.rom.moves[id]!.pp), ppUps: moves.map(() => 0), item: FX.item.LEFTOVERS,
    })],
    trainer: resolvedTrainer(bag, [
      resolvedMon(ID.zigzagoon, 20, [MOVE.thunderWave, MOVE.reflect, ID.tackle, ID.meanLook], { item: FX.item.SITRUS_BERRY, ...lead }),
      resolvedMon(ID.bidoof, 25, bidoof),
    ]),
    field: {},
  };
}

/** `state` restored, changed by `change`, and snapshotted again. */
export function editState(state: EngineState, change: (battle: ReturnType<typeof restore>) => void): EngineState {
  const b = restore(state);
  change(b);
  return snapshot(b);
}

/** The state after one step down each chance's first outcome. */
export const firstOf = (state: EngineState, p1?: Choice, p2?: Choice): EngineState =>
  editState(state, (b) => applyChoices(b, { ...(p1 ? { p1 } : {}), ...(p2 ? { p2 } : {}) }));

/** Every outcome of one turn from `state` (those ending in phase `phase`, if given): at least one. */
export function outcomes(state: EngineState, p1?: Choice, p2?: Choice, phase?: EngineState['phase']['kind']): Outcome[] {
  const out = expandTurn(state, { ...(p1 ? { p1 } : {}), ...(p2 ? { p2 } : {}) }).filter((o) => !phase || o.state.phase.kind === phase);
  expect(out.length).toBeGreaterThan(0);
  return out;
}

/** The AiError code `run` throws (any other error is rethrown). */
export function aiErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AiError) return error.code;
    throw error;
  }
  throw new Error('Expected an AiError');
}
