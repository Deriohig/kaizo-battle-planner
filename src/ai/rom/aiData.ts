// Everything the trainer AI reads from the ROM, cached by `npm run extract` in data/rom/trainer-ai.json: the script,
// the item records, the type chart and the Pokédex weights.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MissingDataError } from '../../data/load.js';
import { readNdsFiles } from '../../nds/ndsFs.js';
import { type AiItemRecord, decodeItems, readArm9 } from './items.js';
import { type AiScript, extractAiScript } from './script.js';
import { extractTypeChart, type TypeChart } from './typeChart.js';
import { decodeWeights } from '../../rom/weights.js';

/**
 * The cache's contents. `scriptWords` is `AiScript.words` as plain numbers, and `items` is indexed by item ID.
 * `weights` and `formWeights` are the Pokédex weights by species ID (hectograms) that a battler of form 0 and of any
 * other form gets (src/rom/weights.ts).
 */
export interface AiRomData {
  scriptWords: number[]; flagEntries: number[]; scriptSha256: string; items: (AiItemRecord | null)[]; typeChart: TypeChart;
  weights: number[]; formWeights: number[];
}

const AI_DATA_FILE = 'trainer-ai.json';
const EXTRACT_HINT = 'run npm run extract -- --rom <path> to extract it';

/** Decodes the AI's data from a ROM. Throws RomError as the decoders do. */
export function extractAiData(rom: Uint8Array): AiRomData {
  const script = extractAiScript(rom);
  const files = readNdsFiles(rom);
  return {
    scriptWords: Array.from(script.words),
    flagEntries: script.flagEntries,
    scriptSha256: script.sha256,
    items: decodeItems(files, readArm9(rom)),
    typeChart: extractTypeChart(rom),
    weights: decodeWeights(files),
    formWeights: decodeWeights(files, 1),
  };
}

/** Decodes the AI's data from `rom` and writes it to `<dir>/trainer-ai.json`, creating `dir` if needed. */
export function writeAiData(rom: Uint8Array, dir: string): void {
  const data = extractAiData(rom);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, AI_DATA_FILE), `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Reads `<dir>/trainer-ai.json`. Throws MissingDataError, saying to run the extract, when it does not exist or an older
 * extract wrote it (no Pokédex weights).
 */
export function loadAiData(dir = join('data', 'rom')): AiRomData {
  const file = join(dir, AI_DATA_FILE);
  if (!existsSync(file)) throw new MissingDataError(`Missing ${file}; ${EXTRACT_HINT}`);
  const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<AiRomData> | null;
  if (!Array.isArray(data?.weights) || !Array.isArray(data.formWeights)) {
    throw new MissingDataError(`${file} predates the Pokédex weights; ${EXTRACT_HINT} again`);
  }
  return data as AiRomData;
}

/** The script as `extractAiScript` gave it: the words back in an Int32Array, and its scriptId. */
export function aiScriptOf(data: AiRomData): AiScript {
  return { words: Int32Array.from(data.scriptWords), flagEntries: [...data.flagEntries], sha256: data.scriptSha256 };
}
