// `tsx scripts/makeSmokeSave.ts <out file> [--seed <n>]`: a made-up Platinum save for the hosted smoke test
// (deploy/smoke.sh) and the load test (scripts/loadTest.ts), so neither needs a real save. It is written by the test
// save encoder (test/fixtures/buildSave.ts), with DeSmuME's footer like a `.dsv`: one trainer with no badges and a
// level 10 Monferno knowing Scratch and Ember. Each seed gives a different trainer ID and PID, so twenty players of the
// load test hold twenty different saves.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSave } from '../test/fixtures/buildSave.js';

const MONFERNO = 391;
const SCRATCH = 10;
const EMBER = 52;
const LEVEL = 10;
/** Gen 4's medium slow curve (Monferno's growth rate) at `LEVEL`: 6n³/5 − 15n² + 100n − 140. */
const EXP_AT_LEVEL = Math.floor((6 * LEVEL ** 3) / 5) - 15 * LEVEL ** 2 + 100 * LEVEL - 140;
/** Monferno's stats at level 10 with 31 IVs, no EVs and a neutral nature: base 64/78/52/78/52/81. */
const STATS = { hp: 35, atk: 22, def: 16, spa: 22, spd: 16, spe: 23 };

/** The smoke save for `seed` (a whole number from 0): the same bytes for the same seed. */
export function smokeSave(seed = 0): Uint8Array {
  const id = (0x5a5a + seed * 7919) & 0xffff;
  return buildSave({
    trainer: { name: 'SMOKE', id, gender: 0, badgeMask: 0 },
    party: [{
      pid: (0x1234_5678 + seed * 104_729) >>> 0, species: MONFERNO, nickname: 'SMOKE', exp: EXP_AT_LEVEL, level: LEVEL,
      moves: [SCRATCH, EMBER], pp: [35, 25], ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      currentHp: STATS.hp, storedStats: STATS, otId: id, otName: 'SMOKE', friendship: 70,
    }],
  });
}

function main(): void {
  const usage = 'Usage: tsx scripts/makeSmokeSave.ts <out file> [--seed <n>]';
  let parsed: { values: { seed?: string }; positionals: string[] };
  try {
    parsed = parseArgs({ options: { seed: { type: 'string' } }, allowPositionals: true });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}. ${usage}`);
    process.exit(2);
  }
  const [out, ...rest] = parsed.positionals;
  const seed = parsed.values.seed === undefined ? 0 : Number(parsed.values.seed);
  if (out === undefined || rest.length > 0 || !Number.isInteger(seed) || seed < 0) {
    console.error(usage);
    process.exit(2);
  }
  writeFileSync(out, smokeSave(seed));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
