// Real-data check: the decompilation's script.s lines up with vanilla US Platinum's AI script, the generated blocks in
// docs/ai-changes.md still match what the diff of the two ROMs produces, and the function-level diff of overlay 16
// puts the obedience change in the function it names.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import {
  AI_CHANGES_DOC, generateBlock, generateMoveBlock, MOVE_BLOCK, moveTable, readGenerated, SCRIPT_S,
} from '../../src/ai/diff/cli.js';
import { functionIndex } from '../../src/ai/diff/handlerDiff.js';
import { battleLayouts, generateHandlerBlock, HANDLER_BLOCK } from '../../src/ai/diff/handlerSection.js';
import { labelsFromSource } from '../../src/ai/diff/labels.js';
import { type AiScript, extractAiScript } from '../../src/ai/rom/script.js';
import { loadDocs } from '../../src/data/load.js';
import { buildNameIndex } from '../../src/names/nameIndex.js';
import { needFiles, PK_ROM, PK_VANILLA_ROM } from './env.js';

/** Vanilla US Platinum (game code CPUE). Like PK_ROM, it can be overridden by the environment variable of the same name. */
/** The pret/pokeplatinum clone. */
const POKEPLATINUM = process.env.POKEPLATINUM || join(homedir(), 'src', 'pokeplatinum');

const suite = needFiles('docs/ai-changes.md against the hack and vanilla ROMs', {
  PK_ROM,
  PK_VANILLA_ROM,
  POKEPLATINUM: join(POKEPLATINUM, SCRIPT_S),
});

describe.skipIf(suite.skip)(suite.title, () => {
  let hackRom: Uint8Array;
  let vanillaRom: Uint8Array;
  let vanilla: AiScript;

  beforeAll(() => {
    hackRom = readFileSync(PK_ROM);
    vanillaRom = readFileSync(PK_VANILLA_ROM);
    vanilla = extractAiScript(vanillaRom);
  });

  it('labelsFromSource aligns all of script.s with the vanilla ROM', () => {
    const labels = labelsFromSource(readFileSync(join(POKEPLATINUM, SCRIPT_S), 'utf8'), vanilla);
    const at = (name: string) => labels.find((label) => label.name === name)?.at;
    expect(at('Basic_Main')).toBe(vanilla.flagEntries[0]);
    expect(at('Harrassment_Main')).toBe(vanilla.flagEntries[10]);
    expect(at('Terminate')).toBe(vanilla.flagEntries[11]);
    expect(at('CatchTutorial_Main')).toBe(vanilla.flagEntries[31]);
  });

  it('the generated block in docs/ai-changes.md is up to date', () => {
    const block = generateBlock({ hackRom, vanillaRom, decompDir: POKEPLATINUM });
    expect(readGenerated(readFileSync(AI_CHANGES_DOC, 'utf8'))).toBe(block);
  });
});

// The handler block reads the decompilation's C, the ARM9's files included (`src` in the sparse checkout).
const handlerSuite = needFiles('docs/ai-changes.md handler block against the hack and vanilla ROMs', {
  PK_ROM,
  PK_VANILLA_ROM,
  POKEPLATINUM: join(POKEPLATINUM, 'src', 'main.c'),
});

/** Where the obedience change is: vanilla overlay 16 offset 0x13090 (`cmp r0, #8` becomes `cmp r0, #0`). */
const OBEDIENCE_OFFSET = 0x13090;

describe.skipIf(handlerSuite.skip)(handlerSuite.title, () => {
  let hackRom: Uint8Array;
  let vanillaRom: Uint8Array;

  beforeAll(() => {
    hackRom = readFileSync(PK_ROM);
    vanillaRom = readFileSync(PK_VANILLA_ROM);
  });

  it('the obedience change sits in BattleControllerPlayer_CheckObedience, the one halfword that differs there', () => {
    const { vanilla, diff } = battleLayouts({ hackRom, vanillaRom, decompDir: POKEPLATINUM });
    const fn = vanilla.functions[functionIndex(vanilla.functions, OBEDIENCE_OFFSET)]!;
    expect(fn.name).toBe('BattleControllerPlayer_CheckObedience');
    const pair = diff.pairs.find((candidate) => candidate.vanilla.start === fn.start)!;
    expect(pair.status).toBe('changed');
    expect(pair.spots).toEqual([{ vanillaStart: OBEDIENCE_OFFSET, vanillaEnd: OBEDIENCE_OFFSET + 2, hackStart: pair.hack.start + OBEDIENCE_OFFSET - fn.start, hackEnd: pair.hack.start + OBEDIENCE_OFFSET - fn.start + 2 }]);
  });

  it('the handler block in docs/ai-changes.md is up to date', () => {
    const block = generateHandlerBlock({ hackRom, vanillaRom, decompDir: POKEPLATINUM });
    expect(readGenerated(readFileSync(AI_CHANGES_DOC, 'utf8'), HANDLER_BLOCK)).toBe(block);
  });
});

// The move-data block names moves by the docs' Moves tab, so it also needs the docs cache.
const caches = inject('realCaches');
const movesSuite = needFiles('docs/ai-changes.md move data against the hack and vanilla ROMs and the docs', {
  PK_ROM,
  PK_VANILLA_ROM,
  POKEPLATINUM: join(POKEPLATINUM, SCRIPT_S),
}, [caches.docs]);

/** generated/moves.txt (line = ID + 1). */
const MOVE_EXPLOSION = 153;
const MOVE_MEMENTO = 262;

describe.skipIf(movesSuite.skip)(movesSuite.title, () => {
  let hackRom: Uint8Array;
  let vanillaRom: Uint8Array;

  beforeAll(() => {
    hackRom = readFileSync(PK_ROM);
    vanillaRom = readFileSync(PK_VANILLA_ROM);
  });

  it('Memento has a different effect in the hack: vanilla Explosion\'s', () => {
    const vanilla = moveTable(vanillaRom);
    const hack = moveTable(hackRom);
    expect(hack[MOVE_MEMENTO]!.effect).not.toBe(vanilla[MOVE_MEMENTO]!.effect);
    expect(hack[MOVE_MEMENTO]!.effect).toBe(vanilla[MOVE_EXPLOSION]!.effect);
  });

  it('the move-data block in docs/ai-changes.md is up to date', () => {
    const names = buildNameIndex(loadDocs(caches.docs.dir));
    const block = generateMoveBlock({ hackRom, vanillaRom, decompDir: POKEPLATINUM, names });
    expect(block).toMatch(/\| 262 \| Memento \|/);
    expect(readGenerated(readFileSync(AI_CHANGES_DOC, 'utf8'), MOVE_BLOCK)).toBe(block);
  });
});
