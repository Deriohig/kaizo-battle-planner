// The trainer AI over test data for the sheet's AI odds: the AI's ROM data running a hand-assembled script (asm.ts),
// plus the records a real ROM has that the AI reads but the small fixtures leave out.

import { createTrainerAi } from '../../../src/ai/index.js';
import type { AiRomData } from '../../../src/ai/rom/aiData.js';
import type { AiScript } from '../../../src/ai/rom/script.js';
import { scriptId } from '../../../src/ai/script/disasm.js';
import type { LoadedData } from '../../../src/battle/types.js';
import type { EnemyModel } from '../../../src/contracts/ai.js';
import { AI_FLAG_NAMES } from '../../../src/rom/trainers.js';
import { assemble } from '../ai/asm.js';
import { fixtureDeps } from '../ai/fixtures.js';

/** A script that leaves every score as it is: the AI's moves tie. */
export const NOTHING = 'PopOrEnd';
/** Half the time, +1 to the slot being scored: each slot's score is its own coin. */
export const COINS = 'IfRandomLessThan 128, Bonus\nPopOrEnd\nBonus: AddToMoveScore 1\nPopOrEnd';

/** The highest species ID the AI's weight tables cover (vanilla Arceus, 493). */
const LAST_SPECIES = 493;

/** Adds to `data` (and returns it) MOVE_NONE's record, species record 0 and AI flag bit 0 (Basic) on every ROM trainer. */
export function withAiRecords(data: LoadedData): LoadedData {
  data.rom.moves[0] = { id: 0, effect: 0, category: 'physical', power: 0, type: 0, accuracy: 0, pp: 0, effectChance: 0, target: 0, priority: 0, flags: 0 };
  data.rom.species[0] = {
    id: 0, baseStats: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, types: [0, 0], genderRatio: 0, baseFriendship: 0, baseExp: 0, evYield: 0,
    growthRate: 0, abilities: [0, 0],
  };
  data.rom.trainers = data.rom.trainers.map((trainer) => ({ ...trainer, aiMask: 1, aiFlags: [AI_FLAG_NAMES[0]!] }));
  return data;
}

/** The AI's ROM data running `src` (with `Terminate: PopOrEnd` appended) as AI flag bit 0, every species weighing 0. */
export function aiRom(src: string): AiRomData {
  const { words, labels } = assemble(`${src}\nTerminate: PopOrEnd`);
  const flagEntries = Array<number>(32).fill(labels.Terminate!);
  flagEntries[0] = 0;
  const script: AiScript = { words, flagEntries, sha256: '' };
  const { items, typeChart } = fixtureDeps();
  const weights = Array<number>(LAST_SPECIES + 1).fill(0);
  return { scriptWords: Array.from(words), flagEntries, scriptSha256: scriptId(script), items, typeChart, weights, formWeights: [...weights] };
}

/** The trainer AI over `data` (with `withAiRecords`), its trainers running `src`. */
export function fixtureAi(data: LoadedData, src: string): EnemyModel {
  return createTrainerAi(data, aiRom(src));
}

/** A model whose script throws AiError('UNKNOWN_OPCODE') as soon as a flag runs; the post-KO replacement still answers. */
export function aiThatNeverThinks(data: LoadedData): EnemyModel {
  const ai = aiRom(NOTHING);
  return createTrainerAi(data, { ...ai, scriptWords: [0x7fff], flagEntries: Array<number>(32).fill(0), scriptSha256: 'never' });
}
