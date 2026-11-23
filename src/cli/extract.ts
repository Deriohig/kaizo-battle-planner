// `npm run extract -- --rom <path>`: decodes the ROM into `data/rom/romdata.json` and `data/rom/trainer-ai.json` and
// downloads the docs tabs into `data/docs/`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { writeAiData } from '../ai/rom/aiData.js';
import { DOC_TABS, DocsError, downloadDocs } from '../docs/fetchDocs.js';
import { RomError } from '../errors.js';
import { extractRomData } from '../rom/extract.js';

const USAGE = 'Usage: npm run extract -- --rom <path>';
const ROM_DIR = join('data', 'rom');
const DOCS_DIR = join('data', 'docs');

/** Decodes the ROM at `romPath`, writes it as pretty JSON and prints the counts. Returns the ROM's bytes. */
function extractRom(romPath: string): Uint8Array {
  const rom = readFileSync(romPath);
  const data = extractRomData(rom);
  mkdirSync(ROM_DIR, { recursive: true });
  writeFileSync(join(ROM_DIR, 'romdata.json'), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`${data.species.length} species, ${data.moves.length} moves, ${data.trainers.length} trainers`);
  return rom;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The `--rom` path. Bad arguments (an unknown flag, a missing value) print one line with the usage. */
function romArg(): string {
  let rom: string | undefined;
  try {
    rom = parseArgs({ options: { rom: { type: 'string' } } }).values.rom;
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`);
  }
  return rom ?? fail(USAGE);
}

/** A Node.js system error, such as ENOENT or EACCES from reading the ROM or writing the output. */
function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === 'string';
}

/** One line for an error the user can act on. Anything else is a bug, so it is rethrown with its stack trace. */
function failureMessage(error: unknown, rom: string): string {
  if (error instanceof RomError) return `Cannot extract ${rom}: ${error.message} (${error.code})`;
  if (error instanceof DocsError) return `Cannot download the docs: ${error.message} (${error.code})`;
  if (isSystemError(error)) return `Cannot extract ${rom}: ${error.message}`;
  throw error;
}

const rom = romArg();
try {
  const romBytes = extractRom(rom);
  writeAiData(romBytes, ROM_DIR);
  await downloadDocs(DOCS_DIR);
  console.log(`${DOC_TABS.length} docs tabs saved in ${DOCS_DIR}`);
} catch (error) {
  fail(failureMessage(error, rom));
}
