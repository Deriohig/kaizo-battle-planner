// `npm run sprites -- [--rom <path>]`: extracts the Pokémon sprites from the ROM into the data folder's `sprites/`
// (`$PKP_DATA`, else `data`), replacing the cache there (src/sprites/extract.ts). The ROM defaults to the hack's file
// in the data folder's `roms/`. The sprites are the game's own art: the folder is git-ignored, never committed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RomError } from '../errors.js';
import { ROM_FILE_NAME } from '../server/setup.js';
import { spritesDir } from '../server/sprites.js';
import { writeSprites } from '../sprites/extract.js';

const USAGE = 'Usage: npm run sprites -- [--rom <path>]';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const dataDir = process.env.PKP_DATA || 'data';
let rom: string;
try {
  rom = parseArgs({ options: { rom: { type: 'string' } } }).values.rom ?? join(dataDir, 'roms', ROM_FILE_NAME);
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`);
}
const dir = spritesDir(dataDir);
try {
  const manifest = await writeSprites(readFileSync(rom), dir);
  console.log(`${manifest.species} species' front, back and icon sprites, ${manifest.forms} alternate forms and the shiny colours saved in ${dir}/`);
  console.log(`Not extracted yet: ${manifest.notExtracted.join('; ')}`);
} catch (error) {
  if (error instanceof RomError) fail(`Cannot extract the sprites from ${rom}: ${error.message} (${error.code})`);
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === 'string') fail(`Cannot extract the sprites from ${rom}: ${error.message}`);
  throw error;
}
